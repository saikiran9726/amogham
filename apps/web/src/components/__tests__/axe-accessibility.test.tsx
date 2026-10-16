import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { PwaUpdatePrompt } from '../PwaUpdatePrompt.js';
import { SessionExpiryModal } from '../SessionExpiryModal.js';
import { ConnectionBanner } from '../ConnectionBanner.js';
import { ToastContainer } from '../ui/Toast.js';

// Mock stores
vi.mock('../../stores/useCartStore.js', () => ({
  useCartStore: (selector: (state: { items: unknown[] }) => unknown) => selector({ items: [] }),
}));
vi.mock('../../stores/useOutboxStore.js', () => ({
  useOutboxStore: (selector: (state: { pendingCount: number }) => unknown) =>
    selector({ pendingCount: 0 }),
}));
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [true, vi.fn()],
    updateServiceWorker: vi.fn(),
  }),
}));

describe('Axe Accessibility Audits', () => {
  it('PwaUpdatePrompt has zero serious or critical accessibility violations', async () => {
    const { container } = render(<PwaUpdatePrompt />);
    const results = await axe.run(container, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa'],
      },
    });

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(criticalOrSerious).toEqual([]);
  });

  it('SessionExpiryModal has zero serious or critical accessibility violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <SessionExpiryModal />
      </MemoryRouter>,
    );
    const results = await axe.run(container, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa'],
      },
    });

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(criticalOrSerious).toEqual([]);
  });

  it('ConnectionBanner has zero serious or critical accessibility violations', async () => {
    const { container } = render(<ConnectionBanner />);
    const results = await axe.run(container, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa'],
      },
    });

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(criticalOrSerious).toEqual([]);
  });

  it('ToastContainer has zero serious or critical accessibility violations', async () => {
    const { container } = render(<ToastContainer />);
    const results = await axe.run(container, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa'],
      },
    });

    const criticalOrSerious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(criticalOrSerious).toEqual([]);
  });
});
