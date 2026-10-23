import { describe, expect, it } from 'vitest';
import { normalise, parseIntent } from './alexaIntents';

describe('Alexa+ simulator intents', () => {
  it('strips the wake word and politeness', () => {
    expect(normalise('Alexa, please run my code!')).toBe('run my code');
    expect(normalise('Hey Alexa ask CodeLens to fix it')).toBe('fix it');
  });

  it('maps everyday phrasing to tools', () => {
    expect(parseIntent('Alexa, run my code')).toEqual({ kind: 'run' });
    expect(parseIntent('explain my program')).toEqual({ kind: 'run' });
    expect(parseIntent('Why did it crash?')).toEqual({ kind: 'summary' });
    expect(parseIntent('what went wrong')).toEqual({ kind: 'summary' });
    expect(parseIntent('fix it')).toEqual({ kind: 'fix' });
    expect(parseIntent('test the fix')).toEqual({ kind: 'validate' });
    expect(parseIntent('apply the fix')).toEqual({ kind: 'apply' });
    expect(parseIntent('where did it stop')).toEqual({ kind: 'state' });
    expect(parseIntent('what happened at step three')).toEqual({ kind: 'state', step: 2 });
    expect(parseIntent('what can you do')).toEqual({ kind: 'help' });
    expect(parseIntent('sing me a song')).toEqual({ kind: 'unknown' });
  });

  it('finds variables, including names spoken as separate words', () => {
    expect(parseIntent('what is total', ['total', 'xs'])).toEqual({ kind: 'variable', name: 'total' });
    expect(parseIntent("what's the total score", ['total', 'total_score'])).toEqual({ kind: 'variable', name: 'total_score' });
    expect(parseIntent('what is the value of count')).toEqual({ kind: 'variable', name: 'count' });
    expect(parseIntent('what is wrong')).toEqual({ kind: 'summary' });
    expect(parseIntent('what is the error', ['count'])).toEqual({ kind: 'summary' });
    expect(parseIntent("what's the problem")).toEqual({ kind: 'summary' });
    expect(parseIntent('what is result', ['result'])).toEqual({ kind: 'variable', name: 'result' });
  });
});
