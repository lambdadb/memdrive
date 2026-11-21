"""Prepare original BEAM questions at conversation end, with evaluation data isolated."""
import argparse
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import tempfile

HERE = Path(__file__).resolve().parent
PROTOCOL = "beam-original-v1"
CATEGORIES = ("abstention", "contradiction_resolution", "event_ordering", "information_extraction",
              "instruction_following", "knowledge_update", "multi_session_reasoning",
              "preference_following", "summarization", "temporal_reasoning")


def timestamp(anchor):
    if anchor is None or anchor == "":
        return None
    value = re.sub(r"(?<=\d)(st|nd|rd|th)\b", "", str(anchor).strip())
    for pattern in ("%B-%d-%Y", "%B %d, %Y", "%B %d %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, pattern).strftime("%Y-%m-%dT12:00:00.000Z")
        except ValueError:
            pass
    raise ValueError(f"Unsupported source time_anchor: {anchor!r}; do not infer a replacement")


def batches(chat):
    """Yield original paths, messages and shared dates without flattening away provenance."""
    for outer, item in enumerate(chat):
        if isinstance(item, list):
            anchor = next((m.get("time_anchor") for m in item if m.get("time_anchor")), None)
            yield [(f"s{outer:03d}_t{index:04d}", message) for index, message in enumerate(item)], anchor
        elif isinstance(item, dict) and "role" in item:
            yield [(f"f{outer:06d}", item)], item.get("time_anchor")
        elif isinstance(item, dict):
            for plan_name, plan in item.items():
                match = re.fullmatch(r"plan-(\d+)", plan_name)
                if not match or not isinstance(plan, list):
                    raise ValueError("Unsupported BEAM plan layout")
                for b, batch in enumerate(plan):
                    entries = [(f"p{int(match[1]):03d}_b{b:04d}_g{g:04d}_t{t:04d}", message)
                               for g, group in enumerate(batch["turns"])
                               for t, message in enumerate(group if isinstance(group, list) else [group])]
                    anchor = batch.get("time_anchor") or next((m.get("time_anchor") for _, m in entries if m.get("time_anchor")), None)
                    yield entries, anchor
        else:
            raise ValueError("Unsupported BEAM chat layout")


def question_groups(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = ast.literal_eval(value)
    if not isinstance(value, dict) or set(value) - set(CATEGORIES):
        raise ValueError("Unsupported BEAM question categories")
    return value


def convert_row(row):
    identity = str(row["conversation_id"])
    profile = row.get("user_profile") or {}
    profile = profile.get("user_info", "") if isinstance(profile, dict) else ""
    match = re.search(r"Name:\s*([^\n•]+)", profile)
    name = match[1].strip() if match else "User"
    messages = []
    for entries, anchor in batches(row["chat"]):
        shared_time = timestamp(anchor)
        for suffix, message in entries:
            content = message.get("content")
            if content is None or isinstance(content, str) and not content.strip():
                continue
            if not isinstance(content, str) or message.get("role") not in ("user", "assistant"):
                raise ValueError("Invalid original source message")
            messages.append({"sourceId": f"{identity}_{suffix}", "ordinal": len(messages),
                             "content": content, "author": {"role": message["role"],
                             "name": name if message["role"] == "user" else "Assistant"},
                             "timestamp": shared_time, "turnId": str(message["id"]) if message.get("id") is not None else ""})
    if not messages:
        raise ValueError("Empty conversation")
    questions, evaluation = [], []
    for category, items in question_groups(row["probing_questions"]).items():
        for index, item in enumerate(items):
            text = item["question"]
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Empty question")
            question_id = f"{identity}_{category}_{index}"
            # No category, source IDs, hints, answer, asOf or rubric in runtime questions.
            questions.append({"id": question_id, "text": text})
            rubric = item.get("rubric")
            if not isinstance(rubric, list) or not rubric or not all(isinstance(x, str) and x.strip() for x in rubric):
                raise ValueError("Missing original rubric")
            evaluation.append({"id": question_id, "category": category, "question": text, "rubric": rubric,
                               "annotation": item})
    return {"protocol": PROTOCOL, "id": identity, "userIdentity": f"user-{identity}",
            "userTraits": {"profile": profile} if profile else {}, "messages": messages, "questions": questions}, evaluation


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(data_dir, output, split):
    import pyarrow.parquet as parquet
    config = json.loads((HERE / "original-config.json").read_text())
    cohort = config["cohorts"][split]
    for file in cohort["files"]:
        source = data_dir / file["name"]
        if source.stat().st_size != file["bytes"] or sha(source) != file["sha256"]:
            raise ValueError(f"Pinned source mismatch: {file['name']}")
    if output.exists():
        raise FileExistsError("Use a new output directory; historical artifacts are immutable")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".beam-original-", dir=output.parent) as temporary:
        staging = Path(temporary) / "prepared"
        staging.mkdir()
        (staging / "conversations").mkdir()
        (staging / "evaluation").mkdir()
        records = []
        for file in cohort["files"]:
            # One dataset row at a time also supports the larger 10M shards.
            for batch in parquet.ParquetFile(data_dir / file["name"]).iter_batches(batch_size=1):
                for row in batch.to_pylist():
                    conversation, evaluation = convert_row(row)
                    identity = conversation["id"]
                    if not re.fullmatch(r"\d+", identity) or any(r["id"] == identity for r in records):
                        raise ValueError("Invalid or duplicate conversation identity")
                    runtime_file, evaluation_file = f"conversations/{identity}.json", f"evaluation/{identity}.json"
                    for name, value in [(runtime_file, conversation), (evaluation_file, evaluation)]:
                        (staging / name).write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
                    records.append({"id": identity, "questions": len(evaluation), "runtime": runtime_file,
                                    "runtimeSha256": sha(staging / runtime_file), "evaluation": evaluation_file,
                                    "evaluationSha256": sha(staging / evaluation_file)})
        if len(records) != cohort["conversations"] or sum(r["questions"] for r in records) != cohort["questions"]:
            raise ValueError("Prepared cohort is incomplete")
        lock = {"protocol": PROTOCOL, "split": split, "datasetRevision": cohort["datasetRevision"],
                "questionPosition": "after_complete_conversation", "conversations": records,
                "sourceFiles": {f["name"]: f["sha256"] for f in cohort["files"]},
                "implementation": {name: sha(HERE / name) for name in ["original.py", "original-config.json", "original-prompts.json"]}}
        (staging / "manifest.json").write_text(json.dumps(lock, indent=2) + "\n")
        staging.rename(output)
    print(f"Prepared {len(records)} complete conversations / {cohort['questions']} questions; no provider calls")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", required=True, choices=["100k", "500k", "1m", "10m"])
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    prepare(args.data_dir, args.output, args.split)
