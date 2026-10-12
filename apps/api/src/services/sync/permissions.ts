import { Permissions } from '@restaurant-os/shared';

export const COMMAND_REQUIRED_PERMISSIONS: Record<string, string> = {
  'order.create': Permissions.ORDER_CREATE,
  'kot.status': Permissions.KOT_UPDATE_STATUS,
  'payment.record': Permissions.PAYMENT_TAKE,
};

export function getRequiredPermissionForCommand(commandType: string): string | undefined {
  return COMMAND_REQUIRED_PERMISSIONS[commandType];
}

export function hasPermissionForCommand(
  commandType: string,
  userPermissions: readonly string[] | undefined,
): boolean {
  const required = getRequiredPermissionForCommand(commandType);
  if (!required) return false;
  return Boolean(userPermissions && userPermissions.includes(required));
}
