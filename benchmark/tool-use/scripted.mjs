// Deterministic transport smoke only. This is never evidence of model behavior.
import { faq, paraphraseTargets, enumeratedCode } from './scenarios.mjs';

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
        add('history', {});
        add('fork', previous => ({ name: 'earlier', version: previous.entries[0].version }));
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
        if (scenario.id !== 'recall') {
            add('write', previous => ({ at, op: 'update', fileId: previous.fileId,
                edits: [{ oldText: 'Retention is 30 days.', newText: 'Retention is 42 days.' }] }));
            add('diff', { at });
            if (scenario.id !== 'draft-checkpoint') add('merge', { at, summary: 'Update current retention guidance' });
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
                    : scenario.id === 'conflict' ? 'Publication is blocked by a concurrent conflict; the edits are not published.'
                        : scenario.id === 'draft-checkpoint' ? 'Private draft trial and before-edit checkpoint are saved; nothing was published.'
                            : scenario.id === 'past-version' ? 'Created earlier from v1; main is unchanged.' : 'Updated and published the current FAQ.' }] }];
        return { model: request.model, status: 'completed', output, usage: { input_tokens: 0, output_tokens: 0 } };
    };
}
