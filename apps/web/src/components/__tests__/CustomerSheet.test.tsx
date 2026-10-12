import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomerSchema } from '@restaurant-os/shared';

const {
  apiFetch,
  cachedFirst,
  cachedPut,
  setCustomer,
  clearCustomer,
  addItem,
  addToast,
  storeState,
} = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  cachedFirst: vi.fn(),
  cachedPut: vi.fn(),
  setCustomer: vi.fn(),
  clearCustomer: vi.fn(),
  addItem: vi.fn(),
  addToast: vi.fn(),
  storeState: {
    customerId: null as string | null,
    customerName: null as string | null,
    customerPhone: null as string | null,
    customerPreferences: null as { tags: string[]; note: string } | null,
  },
}));

vi.mock('../../stores/useAuthStore.js', () => ({ apiFetch }));
vi.mock('../../db/dexie.js', () => ({
  localDb: {
    cachedCustomers: {
      where: () => ({ equals: () => ({ first: cachedFirst }) }),
      put: cachedPut,
    },
  },
}));
vi.mock('../../stores/useCartStore.js', () => ({
  useCartStore: () => ({
    ...storeState,
    setCustomer,
    clearCustomer,
    addItem,
  }),
}));
vi.mock('../../stores/useToastStore.js', () => ({ useToastStore: () => ({ addToast }) }));

import { CustomerSheet } from '../CustomerSheet.js';
import { CustomerChip } from '../CustomerChip.js';

const cachedCustomer = {
  id: 'customer-1',
  phone: '+919876543210',
  name: 'Cached Name',
  preferences: { tags: ['Less spicy'], note: 'Cached note' },
  favouriteItems: [],
  lastOrder: null,
  lastVisitAt: null,
  visitCount: 1,
  updatedAt: Date.now(),
};

function enterValidPhone() {
  fireEvent.change(screen.getByPlaceholderText('98765 43210'), {
    target: { value: '9876543210' },
  });
}

describe('CustomerSheet lookup recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.customerId = null;
    storeState.customerName = null;
    storeState.customerPhone = null;
    storeState.customerPreferences = null;
    cachedFirst.mockResolvedValue(undefined);
    cachedPut.mockResolvedValue(undefined);
    apiFetch.mockRejectedValue(Object.assign(new Error('Lookup unavailable'), { status: 500 }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the new-customer form for a valid phone when lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CustomerSheet isOpen onClose={vi.fn()} />);
    enterValidPhone();

    expect(await screen.findByPlaceholderText('e.g. Ramesh Kumar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save & Attach to Order' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('preserves edited name and preferences when the fresh lookup returns late', async () => {
    cachedFirst.mockResolvedValue(cachedCustomer);
    let resolveLookup!: (value: unknown) => void;
    apiFetch.mockReturnValue(new Promise((resolve) => (resolveLookup = resolve)));
    render(<CustomerSheet isOpen onClose={vi.fn()} />);
    enterValidPhone();

    const nameInput = await screen.findByDisplayValue('Cached Name');
    fireEvent.change(nameInput, { target: { value: 'User Edited Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'No onion' }));
    const noteInput = screen.getByPlaceholderText(
      'Special dietary note (e.g. Nut allergy, extra crispy)',
    );
    fireEvent.change(noteInput, { target: { value: 'User dietary note' } });

    resolveLookup({
      customer: {
        id: 'customer-1',
        phone: '+919876543210',
        name: 'Fresh Server Name',
        preferences: { tags: ['Vegan'], note: 'Fresh server note' },
        favouriteItems: [],
        lastOrder: null,
        lastVisitAt: null,
        visitCount: 2,
      },
    });

    await waitFor(() => expect(cachedPut).toHaveBeenCalled());
    expect(screen.getByPlaceholderText('e.g. Ramesh Kumar')).toHaveValue('User Edited Name');
    expect(screen.getByRole('button', { name: 'No onion' })).toHaveClass('bg-amber-500/20');
    expect(noteInput).toHaveValue('User dietary note');
  });

  it('renders typed text immediately and submits the latest name when saving', async () => {
    const onClose = vi.fn();
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith('/customers/lookup')) {
        return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
      }
      if (url === '/customers') {
        return Promise.resolve({
          customer: {
            id: 'customer-new',
            name: 'Asha Rao',
            phone: '+919876543210',
            preferences: { tags: [], note: '' },
          },
        });
      }
      return Promise.resolve({});
    });
    setCustomer.mockResolvedValue(undefined);
    render(<CustomerSheet isOpen onClose={onClose} />);
    enterValidPhone();

    const nameInput = await screen.findByPlaceholderText('e.g. Ramesh Kumar');
    expect(nameInput).toHaveClass('customer-name-input', 'bg-surface-card');
    expect(nameInput).toHaveStyle({
      color: 'var(--text-primary)',
      backgroundColor: 'var(--bg-card)',
      caretColor: 'var(--text-primary)',
      '-webkit-text-fill-color': 'var(--text-primary)',
    });
    fireEvent.change(nameInput, { target: { value: 'Asha Rao' } });
    expect(nameInput).toHaveValue('Asha Rao');
    fireEvent.click(screen.getByRole('button', { name: 'Save & Attach to Order' }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/customers',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const createCall = apiFetch.mock.calls.find(([url]) => url === '/customers');
    const submittedPayload = JSON.parse(createCall![1].body);
    expect(createCall![1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(submittedPayload.name).toBe('Asha Rao');
    expect(createCustomerSchema.safeParse(submittedPayload).success).toBe(true);
    await waitFor(() =>
      expect(setCustomer).toHaveBeenCalledWith({
        id: 'customer-new',
        name: 'Asha Rao',
        phone: '+919876543210',
        preferences: { tags: [], note: '' },
      }),
    );
    const savedCustomer = setCustomer.mock.calls[0]![0];
    storeState.customerId = savedCustomer.id;
    storeState.customerName = savedCustomer.name;
    storeState.customerPhone = savedCustomer.phone;
    storeState.customerPreferences = savedCustomer.preferences;
    render(<CustomerChip />);
    expect(screen.getByRole('button', { name: 'Edit customer' })).toHaveTextContent('Asha Rao');
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        message: expect.stringContaining('saved and attached'),
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects overlong names with a clear message before submitting', async () => {
    apiFetch.mockImplementation((url: string) =>
      url.startsWith('/customers/lookup')
        ? Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
        : Promise.resolve({}),
    );
    render(<CustomerSheet isOpen onClose={vi.fn()} />);
    enterValidPhone();
    const nameInput = await screen.findByPlaceholderText('e.g. Ramesh Kumar');
    fireEvent.change(nameInput, { target: { value: 'N'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Attach to Order' }));

    expect(addToast).toHaveBeenCalledWith({
      type: 'warning',
      message: 'Customer name must be 100 characters or fewer',
    });
    expect(apiFetch).not.toHaveBeenCalledWith('/customers', expect.anything());
  });

  it('sends JSON headers and the edited name when updating an existing customer', async () => {
    cachedFirst.mockResolvedValue(cachedCustomer);
    setCustomer.mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockImplementation((url: string) =>
      url.startsWith('/customers/lookup')
        ? Promise.reject(Object.assign(new Error('Lookup unavailable'), { status: 500 }))
        : Promise.resolve({}),
    );
    render(<CustomerSheet isOpen onClose={vi.fn()} />);
    enterValidPhone();

    const nameInput = await screen.findByDisplayValue('Cached Name');
    fireEvent.change(nameInput, { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach to Order' })[0]!);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/customers/customer-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const updateCall = apiFetch.mock.calls.find(([url]) => url === '/customers/customer-1');
    expect(updateCall![1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(updateCall![1].body).name).toBe('Asha Rao');
    await waitFor(() =>
      expect(setCustomer).toHaveBeenCalledWith({
        id: 'customer-1',
        name: 'Asha Rao',
        phone: '+919876543210',
        preferences: { tags: ['Less spicy'], note: 'Cached note' },
      }),
    );
    consoleError.mockRestore();
  });

  it('reports development validation details without including the submitted phone or name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith('/customers/lookup')) {
        return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
      }
      return Promise.reject(
        Object.assign(new Error('Validation failed'), {
          status: 400,
          endpoint: '/customers',
          details: { formErrors: [], fieldErrors: { preferences: ['Invalid format'] } },
        }),
      );
    });
    render(<CustomerSheet isOpen onClose={vi.fn()} />);
    enterValidPhone();
    const nameInput = await screen.findByPlaceholderText('e.g. Ramesh Kumar');
    fireEvent.change(nameInput, { target: { value: 'Asha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Attach to Order' }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        type: 'danger',
        message: 'preferences: Invalid format',
      }),
    );
    expect(warn).toHaveBeenCalledWith('[CustomerSheet] Customer request failed', {
      endpoint: '/customers',
      status: 400,
      validationDetails: { formErrors: [], fieldErrors: { preferences: ['Invalid format'] } },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('9876543210');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Asha');
  });
});
