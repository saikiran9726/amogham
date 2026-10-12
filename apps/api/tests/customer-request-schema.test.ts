import { describe, expect, it } from 'vitest';
import { createCustomerSchema, updateCustomerWaiterSchema } from '@restaurant-os/shared';

describe('waiter customer request schemas', () => {
  const validCustomer = {
    phone: '+919876543210',
    name: 'Asha',
    preferences: { tags: [], note: '' },
  };

  it('accepts a valid short name and Indian phone in the create request object', () => {
    expect(createCustomerSchema.parse(validCustomer)).toMatchObject(validCustomer);
  });

  it('rejects a JSON string as the request body instead of interpreting it as an object', () => {
    const result = createCustomerSchema.safeParse(JSON.stringify(validCustomer));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().formErrors).toContain('Expected object, received string');
    }
  });

  it('accepts the same short name in an existing customer update request', () => {
    expect(
      updateCustomerWaiterSchema.parse({
        name: validCustomer.name,
        preferences: validCustomer.preferences,
      }),
    ).toEqual({ name: 'Asha', preferences: { tags: [], note: '' } });
  });
});
