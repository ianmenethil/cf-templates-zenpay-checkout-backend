import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { OutcomeBadge } from '@/components/OutcomeBadge';
import { StateBadge } from '@/components/StateBadge';
import { OUTCOME_LABELS, STATE_LABELS } from '@/lib/labels';
import { CALLBACK_OUTCOMES, PAYMENT_STATES } from '../../../src/shared/types';
import { renderPanel } from './helpers';

/** Whether the element is painted green, which only a success may be. */
const looksGreen = (element: Element): boolean => element.className.includes('emerald');

describe('StateBadge', () => {
  it.each(PAYMENT_STATES)('shows the label and the meaning of %s', async (state) => {
    await renderPanel(<StateBadge state={state} />);
    const badge = page.getByText(STATE_LABELS[state].label);
    await expect.element(badge).toBeVisible();
    await expect.element(badge).toHaveAttribute('title', STATE_LABELS[state].hint);
  });

  it('is green only for succeeded', async () => {
    for (const state of PAYMENT_STATES) {
      const screen = await renderPanel(<StateBadge state={state} />);
      const badge = screen.getByText(STATE_LABELS[state].label).element();
      expect(looksGreen(badge), state).toBe(state === 'succeeded');
      await screen.unmount();
    }
  });

  it('draws unverified as a dashed warning, not a success', async () => {
    const screen = await renderPanel(<StateBadge state="unverified" />);
    const badge = screen.getByText('Unverified').element();
    expect(looksGreen(badge)).toBe(false);
    expect(getComputedStyle(badge).borderStyle).toBe('dashed');
  });

  it('gives each state its own icon so colour is not the only cue', async () => {
    const icons = new Set<string>();
    for (const state of PAYMENT_STATES) {
      const screen = await renderPanel(<StateBadge state={state} />);
      const icon = screen.getByText(STATE_LABELS[state].label).element().querySelector('svg');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      icons.add(icon?.innerHTML ?? '');
      await screen.unmount();
    }
    expect(icons.size).toBe(PAYMENT_STATES.length);
  });
});

describe('OutcomeBadge', () => {
  it.each(CALLBACK_OUTCOMES)('shows the label and the meaning of %s', async (outcome) => {
    await renderPanel(<OutcomeBadge outcome={outcome} />);
    const badge = page.getByText(OUTCOME_LABELS[outcome].label);
    await expect.element(badge).toBeVisible();
    await expect.element(badge).toHaveAttribute('title', OUTCOME_LABELS[outcome].hint);
  });

  it('is green only for verified', async () => {
    for (const outcome of CALLBACK_OUTCOMES) {
      const screen = await renderPanel(<OutcomeBadge outcome={outcome} />);
      const badge = screen.getByText(OUTCOME_LABELS[outcome].label).element();
      expect(looksGreen(badge), outcome).toBe(outcome === 'verified');
      await screen.unmount();
    }
  });

  it('draws unsigned as a dashed warning, not a success', async () => {
    const screen = await renderPanel(<OutcomeBadge outcome="unsigned" />);
    const badge = screen.getByText('Unsigned').element();
    expect(looksGreen(badge)).toBe(false);
    expect(getComputedStyle(badge).borderStyle).toBe('dashed');
  });

  it('gives each outcome its own icon', async () => {
    const icons = new Set<string>();
    for (const outcome of CALLBACK_OUTCOMES) {
      const screen = await renderPanel(<OutcomeBadge outcome={outcome} />);
      icons.add(screen.getByText(OUTCOME_LABELS[outcome].label).element().querySelector('svg')?.innerHTML ?? '');
      await screen.unmount();
    }
    expect(icons.size).toBe(CALLBACK_OUTCOMES.length);
  });
});
