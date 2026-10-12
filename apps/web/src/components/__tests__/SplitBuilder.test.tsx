import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplitBuilder } from '../SplitBuilder.js';

describe('SplitBuilder remaining balance validation', () => {
  afterEach(cleanup);

  it('caps the payment amount at the remaining balance for cash and card', () => {
    render(
      <SplitBuilder totalBillPaise={10_000} alreadyPaidPaise={3_000} onSubmitPayment={vi.fn()} />,
    );

    const amountInput = screen.getAllByRole('spinbutton')[0]!;
    expect(amountInput).toHaveAttribute('max', '70');

    fireEvent.click(screen.getByRole('radio', { name: 'Card' }));
    expect(amountInput).toHaveAttribute('max', '70');
  });
});
