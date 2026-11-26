// Deterministic transport smoke only. This is never evidence of model behavior.
import { faq, paraphraseTargets, enumeratedCode, handoff, junk } from './scenarios.mjs';

const retention = [{ oldText: 'Retention is 30 days.', newText: 'Retention is 42 days.' }];

export function scriptedAgent(scenario, guide) {
    const steps = [];
    const add = (name, args) => steps.push({ name, args });
    if (guide === 'tool') {
        add('guide', {});
        add('guide', { topic: 'retrieval' });
    }
    if (scenario.id === 'enumerate') {
        // The literal control: an exact identifier across every directory.
        add('findText', { query: enumeratedCode });
    } else if (scenario.id in paraphraseTargets) {
        add('search', { query: scenario.task });
        add('read', { path: paraphraseTargets[scenario.id] });
    } else if (scenario.id === 'record') {
        add('search', { query: 'on-call handoff', mode: 'keyword' });
        add('write', { op: 'create', path: '/notes/on-call-handoff.md', content: `# On-call handoff\n\nAs stated by the user:\n\n> ${handoff}\n` });
    } else if (scenario.id === 'cleanup') {
        add('tree', {});
        add('list', { prefix: '/import/' });
        add('read', { paths: Object.keys(junk) });
        add('write', previous => ({ operations: previous.map(file => ({ op: 'delete', fileId: file.fileId })) }));
    } else {
        add('search', { query: 'current support retention', rerank: false });
        if (scenario.id === 'maintain') {
            add('read', { paths: ['/faq.md', '/policy.md'] });
            add('write', previous => ({ operations: previous.map(file => ({ op: 'update', fileId: file.fileId, edits: retention })) }));
        } else {
            add('read', { path: '/faq.md' });
            // In the conflict task, the FAQ changes after this read; the exact edit is rejected.
            if (scenario.id === 'conflict') add('write', previous => ({ op: 'update', fileId: previous.fileId, edits: retention }));
        }
    }
    let index = 0;
    return async request => {
        const step = steps[index++];
        const prior = request.input.filter(item => item.type === 'function_call_output').at(-1);
        const previous = prior && JSON.parse(prior.output);
        const output = step ? [{ type: 'function_call', call_id: `script-${index}`, name: step.name,
            arguments: JSON.stringify(typeof step.args === 'function' ? step.args(previous) : step.args) }]
            : [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text',
                text: scenario.id === 'recall' ? faq(42) + 'Source: /faq.md'
                    : scenario.id === 'enumerate' ? [...new Set(previous.hits.map(hit => hit.path))].join('\n')
                    : scenario.id in paraphraseTargets ? `${previous.content}Source: ${previous.path}`
                    : scenario.id === 'conflict' ? 'Blocked: someone else changed the FAQ retention concurrently, so my edit was not applied.'
                        : scenario.id === 'record' ? 'Saved the statement verbatim in /notes/on-call-handoff.md.'
                            : scenario.id === 'cleanup' ? 'Deleted the two imported junk files.'
                                : 'Updated the support FAQ and the retention policy to 42 days.' }] }];
        return { model: request.model, status: 'completed', output, usage: { input_tokens: 0, output_tokens: 0 } };
    };
}
