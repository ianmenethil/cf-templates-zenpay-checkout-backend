import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ConfirmDeleteDialog } from '@/components/ConfirmDeleteDialog';
import { renderPanel } from './helpers';

const props = () => ({
  title: 'Delete this payment?',
  description: 'The payment for Jane Citizen and its 3 callbacks will be deleted. This cannot be undone.',
  open: true,
  onOpenChange: vi.fn(),
  onConfirm: vi.fn(),
});

describe('ConfirmDeleteDialog', () => {
  it('asks the question and says what goes with it', async () => {
    await renderPanel(<ConfirmDeleteDialog {...props()} />);
    await expect.element(page.getByRole('alertdialog')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Delete this payment?' })).toBeVisible();
    await expect.element(page.getByText('This cannot be undone.', { exact: false })).toBeVisible();
  });

  it('does not delete until the person confirms', async () => {
    const p = props();
    await renderPanel(<ConfirmDeleteDialog {...p} />);
    expect(p.onConfirm).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Delete' }).click();
    expect(p.onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels from the Cancel button, with focus on it, and from Escape', async () => {
    const p = props();
    await renderPanel(<ConfirmDeleteDialog {...p} />);
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
    await userEvent.keyboard('{Escape}');
    expect(p.onOpenChange).toHaveBeenCalled();
    expect(p.onConfirm).not.toHaveBeenCalled();
  });

  it('shows nothing while closed', async () => {
    await renderPanel(<ConfirmDeleteDialog {...props()} open={false} />);
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
  });
});
