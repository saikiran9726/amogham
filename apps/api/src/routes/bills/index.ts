import type { FastifyInstance } from 'fastify';
import { Permissions } from '@restaurant-os/shared';
import { registerRouteGuard } from '../../auth/middleware.js';
import { createBillRoutes } from './create.js';
import { listBillRoutes } from './list.js';
import { paymentRoutes } from './payments.js';
import { redeemRoutes } from './redeem.js';
import { refundRoutes } from './refund.js';
import { printBillRoutes } from './print.js';

export async function billsRoutes(fastify: FastifyInstance) {
  // Register permissions in central route registry
  registerRouteGuard({
    method: 'POST',
    url: '/orders/:id/bill',
    isPublic: false,
    permission: Permissions.BILL_CREATE,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/bills/:id',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'PATCH',
    url: '/bills/:id/discount',
    isPublic: false,
    permission: Permissions.DISCOUNT_APPLY,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/payments',
    isPublic: false,
    permission: Permissions.PAYMENT_TAKE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/payments/:id/confirm',
    isPublic: false,
    permission: Permissions.PAYMENT_TAKE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/cancel',
    isPublic: false,
    permission: Permissions.BILL_CREATE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/refunds',
    isPublic: false,
    permission: Permissions.BILL_REFUND,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/bills',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/payments/pending',
    isPublic: false,
    permission: Permissions.PAYMENT_TAKE,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/reprint',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/bills/:id/receipt',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/print-events',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'GET',
    url: '/bills/:id/payment-requests',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/payment-requests',
    isPublic: false,
    permission: Permissions.BILL_READ,
  });
  registerRouteGuard({
    method: 'POST',
    url: '/bills/:id/redeem',
    isPublic: false,
    permission: Permissions.PAYMENT_TAKE,
  });

  // Mount modular sub-routes
  await fastify.register(createBillRoutes);
  await fastify.register(listBillRoutes);
  await fastify.register(paymentRoutes);
  await fastify.register(redeemRoutes);
  await fastify.register(refundRoutes);
  await fastify.register(printBillRoutes);
}

export default billsRoutes;
