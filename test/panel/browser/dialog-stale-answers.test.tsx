import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CallbackDialog } from '@/components/CallbackDialog';
import { PaymentDialog } from '@/components/PaymentDialog';
import type { CallbackDetail, PaymentDetail } from '../../../src/shared/types';
import { defer, makeCallbackDetail, makePaymentDetail } from '../fixtures';
import { apiError, renderPanel, stubApi } from './helpers';

const noop = () => undefined;

describe('a dialog whose ID changes while an earlier answer is still on its way', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PaymentDialog ignores an earlier payment that fails late', async () => {
    const first = defer<Response>();
    stubApi((request) =>
      request.path.endsWith('/pay-1')
        ? first.promise
        : { payment: makePaymentDetail({ id: 'pay-2', customerName: 'Sam Smith' }) satisfies PaymentDetail },
    );
    const screen = await renderPanel(<PaymentDialog id="pay-1" open onOpenChange={noop} onCopy={noop} onDelete={noop} />);
    await screen.rerender(<PaymentDialog id="pay-2" open onOpenChange={noop} onCopy={noop} onDelete={noop} />);
    await expect.element(page.getByText('Make Payment for Sam Smith.')).toBeVisible();
    first.resolve(apiError('Gone', 404));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(page.getByText('Make Payment for Sam Smith.')).toBeVisible();
    await expect.element(page.getByText('Could not load this payment. It may have been deleted.')).not.toBeInTheDocument();
  });

  it('CallbackDialog ignores an earlier callback that arrives late', async () => {
    const first = defer<{ callback: CallbackDetail }>();
    stubApi((request) =>
      request.path.endsWith('/cb-1') ? first.promise : { callback: makeCallbackDetail({ id: 'cb-2', paymentId: 'pay-second' }) },
    );
    const screen = await renderPanel(<CallbackDialog id="cb-1" open onOpenChange={noop} onCopy={noop} onOpenPayment={noop} />);
    await screen.rerender(<CallbackDialog id="cb-2" open onOpenChange={noop} onCopy={noop} onOpenPayment={noop} />);
    await expect.element(page.getByText('pay-second')).toBeVisible();
    first.resolve({ callback: makeCallbackDetail({ id: 'cb-1', paymentId: 'pay-first' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(page.getByText('pay-second')).toBeVisible();
    await expect.element(page.getByText('pay-first')).not.toBeInTheDocument();
  });

  it('CallbackDialog ignores an earlier callback that fails late', async () => {
    const first = defer<Response>();
    stubApi((request) =>
      request.path.endsWith('/cb-1') ? first.promise : { callback: makeCallbackDetail({ id: 'cb-2', paymentId: 'pay-second' }) },
    );
    const screen = await renderPanel(<CallbackDialog id="cb-1" open onOpenChange={noop} onCopy={noop} onOpenPayment={noop} />);
    await screen.rerender(<CallbackDialog id="cb-2" open onOpenChange={noop} onCopy={noop} onOpenPayment={noop} />);
    await expect.element(page.getByText('pay-second')).toBeVisible();
    first.resolve(apiError('Gone', 404));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(page.getByText('Could not load this callback. It may have been deleted.')).not.toBeInTheDocument();
    await expect.element(page.getByText('pay-second')).toBeVisible();
  });
});
