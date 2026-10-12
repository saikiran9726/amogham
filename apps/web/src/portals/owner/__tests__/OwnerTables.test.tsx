import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Permissions, Roles } from '@restaurant-os/shared';
import { RequireAuth } from '../../../components/RequireAuth.js';
import { apiFetch, useAuthStore } from '../../../stores/useAuthStore.js';
import OwnerPortal from '../index.js';

vi.mock('../../../stores/useAuthStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../stores/useAuthStore.js')>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);
const ownerUser = {
  id: '00000000-0000-4000-8000-000000000001',
  restaurantId: '00000000-0000-4000-8000-000000000002',
  name: 'Owner',
  username: 'owner',
  role: Roles.OWNER,
  active: true,
  permissions: [Permissions.TABLE_MANAGE],
};

function renderOwner(path: string, permissions = ownerUser.permissions) {
  useAuthStore.setState({
    user: { ...ownerUser, permissions },
    isAuthenticated: true,
    isLoading: false,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/owner/*"
            element={
              <RequireAuth allowedRoles={[Roles.OWNER, Roles.MANAGER]}>
                <OwnerPortal />
              </RequireAuth>
            }
          />
          <Route path="/forbidden" element={<div>Forbidden</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe('owner table management', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
    useAuthStore.getState().clearSession();
  });

  it('protects the route and navigation link with table management permission', async () => {
    apiFetchMock.mockResolvedValue([]);
    const { queryClient } = renderOwner('/owner/tables', []);

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /floor tables/i })).not.toBeInTheDocument();
    queryClient.clear();
  });

  it('creates a table with its fields, shows it after refresh, and exposes the owner route', async () => {
    const createdTable = {
      id: '00000000-0000-4000-8000-000000000003',
      restaurantId: ownerUser.restaurantId,
      label: 'Patio 2',
      capacity: 6,
      section: 'Patio',
      active: true,
      sortOrder: 0,
    };
    let saved = false;
    apiFetchMock.mockImplementation(async (url, options) => {
      if (url === '/alerts?status=open') return [];
      if (url === '/tables' && options?.method === 'POST') {
        saved = true;
        return createdTable;
      }
      if (url === '/tables') return saved ? [createdTable] : [];
      throw new Error(`Unexpected API request: ${url}`);
    });

    const { queryClient } = renderOwner('/owner/tables');

    expect(await screen.findByRole('heading', { name: 'Floor Tables' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /floor tables/i }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add Table' }));

    fireEvent.change(screen.getByPlaceholderText('e.g. T-01, Rooftop-4'), {
      target: { value: 'Patio 2' },
    });
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '6' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Main Floor, Outdoor'), {
      target: { value: 'Patio' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Table' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/tables',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ label: 'Patio 2', capacity: 6, section: 'Patio' }),
        }),
      ),
    );
    expect(await screen.findByText('Patio 2')).toBeInTheDocument();
    expect(
      apiFetchMock.mock.calls.filter(([url]) => url === '/tables').length,
    ).toBeGreaterThanOrEqual(2);
    queryClient.clear();
  });
});
