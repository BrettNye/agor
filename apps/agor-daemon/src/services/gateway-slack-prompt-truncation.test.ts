/**
 * Slack prompt truncation must be visible (preset-io/agor#2744): an explicit
 * omission marker in the prompt, one `[gateway]` warning per cut that carries
 * lengths but never the message text, and the live @mention keeps its line
 * breaks.
 */
import type { GatewayChannel, GatewayOutboundMessage } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  buildSeededThreadInitialPrompt,
  formatSlackCatchUpPrompt,
  SLACK_LIVE_MENTION_MAX_CHARS,
  SLACK_SEED_QUOTE_MAX_CHARS,
  SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS,
} from './gateway.js';

const channel = {
  id: 'gw-slack-1',
  name: 'Slack',
  channel_type: 'slack',
} as unknown as GatewayChannel;

const THREAD_ID = 'C123-100.000000';

function historyMessage(text: string, ts = '101.000000') {
  return {
    ts,
    iso_time: '2026-06-22T00:00:01.000Z',
    actor_label: 'Bob',
    text,
    is_bot: false,
    is_trigger: false,
    is_mention: false,
  };
}

function catchUpPrompt(currentText: string, messages = [historyMessage('earlier note')]) {
  return formatSlackCatchUpPrompt({
    channel,
    threadId: THREAD_ID,
    currentText,
    metadata: { channel: 'C123', slack_message_ts: '103.000000', slack_user_name: 'Alice' },
    messages,
    reason: 'initial_thread_context',
  });
}

function seededPrompt(seedText: string, replyText: string) {
  const seed = {
    id: 'seed-1',
    gateway_channel_id: channel.id,
    channel_type: 'slack',
    platform_channel_id: 'C999',
    platform_thread_id: 'C999-500.000000',
    emitted_by_user_id: 'user-1',
    message_text: seedText,
  } as unknown as GatewayOutboundMessage;
  return buildSeededThreadInitialPrompt({
    seed,
    channel,
    replyText,
    metadata: { channel: 'C999', slack_user_name: 'Alice' },
  });
}

/** A long run of distinctive text so leaks into logs are easy to spot. */
function longText(label: string, length: number): string {
  return `${label}-`.repeat(Math.ceil(length / (label.length + 1))).slice(0, length);
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('criterion 1: truncated Slack text carries an explicit omission marker', () => {
  it('marks a live @mention longer than its limit with the omitted count', () => {
    const prompt = catchUpPrompt(longText('live', SLACK_LIVE_MENTION_MAX_CHARS + 250));
    expect(prompt).toContain('[Agor omitted 250 characters');
  });

  it('marks a prior thread message longer than its limit with the omitted count', () => {
    const prompt = catchUpPrompt('short summon', [
      historyMessage(longText('history', SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS + 40)),
    ]);
    const historyLine = prompt.split('\n').find((line) => line.startsWith('- **Bob**'));
    expect(historyLine).toContain('[Agor omitted 40 characters');
  });

  it('marks the outbound seed message and the first reply with their omitted counts', () => {
    const prompt = seededPrompt(
      longText('seed', SLACK_SEED_QUOTE_MAX_CHARS + 7),
      longText('reply', SLACK_SEED_QUOTE_MAX_CHARS + 13)
    );
    expect(prompt).toContain('> [Agor omitted 7 characters');
    expect(prompt).toContain('> [Agor omitted 13 characters');
  });

  it('adds no marker when every message fits', () => {
    const prompt = catchUpPrompt('short summon');
    expect(prompt).not.toContain('Agor omitted');
    expect(seededPrompt('seed', 'reply')).not.toContain('Agor omitted');
  });
});

describe('criterion 2: each truncation logs one [gateway] warning without message text', () => {
  it('warns once for a truncated live @mention with original and kept lengths', () => {
    const text = longText('secretlive', SLACK_LIVE_MENTION_MAX_CHARS + 100);
    catchUpPrompt(text);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line.startsWith('[gateway]')).toBe(true);
    expect(line).toContain('part=live_mention');
    expect(line).toContain(`thread_id=${THREAD_ID}`);
    expect(line).toContain(`original_chars=${SLACK_LIVE_MENTION_MAX_CHARS + 100}`);
    expect(line).toContain(`kept_chars=${SLACK_LIVE_MENTION_MAX_CHARS}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secretlive');
  });

  it('warns once per truncated thread history message without its text', () => {
    catchUpPrompt('short summon', [
      historyMessage(longText('secrethistA', SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS + 5)),
      historyMessage('fits fine', '101.500000'),
      historyMessage(
        longText('secrethistB', SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS + 9),
        '102.000000'
      ),
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map((call) => String(call[0]));
    for (const line of lines) {
      expect(line.startsWith('[gateway]')).toBe(true);
      expect(line).toContain('part=thread_history_message');
      expect(line).toContain(`kept_chars=${SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS}`);
    }
    expect(lines[0]).toContain(`original_chars=${SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS + 5}`);
    expect(lines[1]).toContain(`original_chars=${SLACK_THREAD_HISTORY_MESSAGE_MAX_CHARS + 9}`);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secrethist/);
  });

  it('warns once each for a truncated seed message and first reply without their text', () => {
    seededPrompt(
      longText('secretseed', SLACK_SEED_QUOTE_MAX_CHARS + 1),
      longText('secretreply', SLACK_SEED_QUOTE_MAX_CHARS + 2)
    );
    expect(warn).toHaveBeenCalledTimes(2);
    const [seedLine, replyLine] = warn.mock.calls.map((call) => String(call[0]));
    expect(seedLine.startsWith('[gateway]')).toBe(true);
    expect(seedLine).toContain('part=seed_message');
    expect(seedLine).toContain(`original_chars=${SLACK_SEED_QUOTE_MAX_CHARS + 1}`);
    expect(seedLine).toContain(`kept_chars=${SLACK_SEED_QUOTE_MAX_CHARS}`);
    expect(replyLine.startsWith('[gateway]')).toBe(true);
    expect(replyLine).toContain('part=first_reply');
    expect(replyLine).toContain(`original_chars=${SLACK_SEED_QUOTE_MAX_CHARS + 2}`);
    expect(replyLine).toContain(`kept_chars=${SLACK_SEED_QUOTE_MAX_CHARS}`);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secretseed|secretreply/);
  });

  it('does not warn when nothing is truncated', () => {
    catchUpPrompt('short summon');
    seededPrompt('seed', 'reply');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('criterion 3: a multi-line live @mention keeps its line breaks', () => {
  it('renders each line of the live mention on its own prompt line', () => {
    const prompt = catchUpPrompt('first line\nsecond line\r\n\nfourth line');
    const summon = prompt.slice(prompt.indexOf('### Current summon'));
    expect(summon).toContain('first line\n  second line\n  \n  fourth line');
    expect(summon).not.toContain('first line second line');
  });

  it('keeps line breaks when a multi-line live mention is also truncated', () => {
    const text = `line one\nline two\n${longText('tail', SLACK_LIVE_MENTION_MAX_CHARS)}`;
    const prompt = catchUpPrompt(text);
    expect(prompt).toContain('line one\n  line two\n  tail-');
    expect(prompt).toContain('\n  [Agor omitted 18 characters');
  });
});
