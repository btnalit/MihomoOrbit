import { describe, expect, it } from 'vitest';
import { isAgentSourced, shouldStartDirectCollector } from './orchestration.js';

// M1c final-review finding 2: the milestone's core invariant — a backend
// with agent_token set is NEVER given a direct collector, even if api_url
// is also set (dual-channel) — had no automated test. These cover all four
// (api_url, agent_token) combinations for both predicates.

describe('isAgentSourced', () => {
  it('is false when agent_token is empty, regardless of api_url', () => {
    expect(isAgentSourced({ agent_token: '' })).toBe(false);
  });

  it('is true when agent_token is set', () => {
    expect(isAgentSourced({ agent_token: 'ag_abc123' })).toBe(true);
  });
});

describe('shouldStartDirectCollector', () => {
  it('api_url set, agent_token empty -> qualifies for a direct collector', () => {
    expect(
      shouldStartDirectCollector({ agent_token: '', api_url: 'http://10.0.0.1:9090' }),
    ).toBe(true);
  });

  it('api_url empty, agent_token empty -> does not qualify (nothing to connect to)', () => {
    expect(shouldStartDirectCollector({ agent_token: '', api_url: '' })).toBe(false);
  });

  it('api_url empty, agent_token set -> does not qualify (agent-sourced, no api_url anyway)', () => {
    expect(
      shouldStartDirectCollector({ agent_token: 'ag_abc123', api_url: '' }),
    ).toBe(false);
  });

  it('a backend with agent_token never qualifies for a direct collector, even with api_url set', () => {
    expect(
      shouldStartDirectCollector({
        agent_token: 'ag_abc123',
        api_url: 'http://10.0.0.1:9090',
      }),
    ).toBe(false);
  });

  it('treats a whitespace-only api_url as unset', () => {
    expect(shouldStartDirectCollector({ agent_token: '', api_url: '   ' })).toBe(false);
  });
});
