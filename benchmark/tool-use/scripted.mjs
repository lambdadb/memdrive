// Deterministic transport smoke only. This is never evidence of model behavior.
import { faq, paraphraseTargets, enumeratedCode } from './scenarios.mjs';

const retention = [{ oldText: 'Retention is 30 days.', newText: 'Retention is 42 days.' }];
const mainAt = { kind: 'main' };

export function scriptedAgent(scenario, guide) {
    const steps = [];
    // Work on the host-named starting view, or on the requested draft.
    const at = scenario.id === 'draft-checkpoint' ? { kind: 'fork', name: 'trial' } : scenario.start;
    const target = at ? { at } : {};
    const add = (name, args) => steps.push({ name, args });
    if (guide === 'tool') {
        add('guide', {});
        add('guide', { topic: 'retrieval' });
    }
    if (scenario.id === 'past-version') {
        add('listCheckpoints', {});
        add('fork', previous => ({ at: previous.checkpoints.find(item => item.at.name === 'before-change').at, name: 'earlier' }));
    } else if (scenario.id === 'restore') {
        add('listCheckpoints', {});
        add('rollback', previous => ({ at: mainAt, to: previous.checkpoints.find(item => item.at.name === 'before-import').at }));
        add('read', { path: '/faq.md' });
    } else if (scenario.id === 'enumerate') {
        // The literal control: an exact identifier across every directory.
        add('findText', { query: enumeratedCode });
    } else if (scenario.id in paraphraseTargets) {
        add('search', { query: scenario.task });
        add('read', { path: paraphraseTargets[scenario.id] });
    } else {
        if (scenario.id === 'draft-checkpoint') {
            add('fork', { name: 'trial' });
            add('checkpoint', previous => ({ at: previous.at, name: 'before-edit' }));
        }
        add('search', { ...target, query: 'current support retention', rerank: false });
        add('read', { ...target, path: '/faq.md' });
        if (scenario.id !== 'recall') add('write', previous => ({ at, op: 'update', fileId: previous.fileId, edits: retention }));
        if (scenario.id === 'conflict') add('read', { at: mainAt, path: '/faq.md' });
        else if (scenario.id === 'maintain' || scenario.id === 'unrelated') {
            // Carry the fork's changes to main: compare both views, then edit main's originals.
            const paths = scenario.id === 'maintain' ? ['/faq.md', '/policy.md'] : ['/faq.md'];
            add('read', { at, paths });
            add('read', { at: mainAt, paths });
            add('write', previous => ({ at: mainAt, operations: previous.map(file => ({ op: 'update', fileId: file.fileId, edits: retention })) }));
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
                    : scenario.id === 'conflict' ? 'Blocked: main has a concurrent conflicting change to the FAQ, so the edit is not applied to main.'
                        : scenario.id === 'draft-checkpoint' ? 'Private draft trial and before-edit checkpoint are saved; main is unchanged.'
                            : scenario.id === 'past-version' ? 'Created earlier from the before-change checkpoint; main is unchanged.'
                                : scenario.id === 'restore' ? 'Rolled main back to the before-import checkpoint; the checkpoint remains.'
                                    : 'Updated the current FAQ on the fork and on main.' }] }];
        return { model: request.model, status: 'completed', output, usage: { input_tokens: 0, output_tokens: 0 } };
    };
}
