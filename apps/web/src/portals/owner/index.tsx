import React, { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { OwnerLayout } from './OwnerLayout.js';
import { EmptyState, Skeleton } from '../../components/ui/UtilityComponents.js';
import { Settings } from 'lucide-react';
import { ErrorBoundary } from '../../components/ErrorBoundary.js';
import { RequireAuth } from '../../components/RequireAuth.js';
import { Permissions } from '@restaurant-os/shared';

// Code-split owner portal routes to minimize initial chunk size
const OwnerHome = lazy(() => import('./OwnerHome.js').then((m) => ({ default: m.OwnerHome })));
const OwnerStaff = lazy(() => import('./OwnerStaff.js').then((m) => ({ default: m.OwnerStaff })));
const OwnerAudit = lazy(() => import('./OwnerAudit.js').then((m) => ({ default: m.OwnerAudit })));
const OwnerPaymentsView = lazy(() => import('./OwnerPaymentsView.js').then((m) => ({ default: m.OwnerPaymentsView })));
const OwnerCustomers = lazy(() => import('./OwnerCustomers.js').then((m) => ({ default: m.OwnerCustomers })));
const OwnerLoyalty = lazy(() => import('./OwnerLoyalty.js').then((m) => ({ default: m.OwnerLoyalty })));
const OwnerSales = lazy(() => import('./OwnerSales.js').then((m) => ({ default: m.OwnerSales })));
const OwnerCloseDay = lazy(() => import('./OwnerCloseDay.js').then((m) => ({ default: m.OwnerCloseDay })));
const OwnerInventory = lazy(() => import('./OwnerInventory.js').then((m) => ({ default: m.OwnerInventory })));
const OwnerPurchases = lazy(() => import('./OwnerPurchases.js').then((m) => ({ default: m.OwnerPurchases })));
const OwnerExpenses = lazy(() => import('./OwnerExpenses.js').then((m) => ({ default: m.OwnerExpenses })));
const OwnerMonthReview = lazy(() => import('./OwnerMonthReview.js').then((m) => ({ default: m.OwnerMonthReview })));
const OwnerHealth = lazy(() => import('./OwnerHealth.js').then((m) => ({ default: m.OwnerHealth })));
const OwnerHealthSettings = lazy(() => import('./OwnerHealthSettings.js').then((m) => ({ default: m.OwnerHealthSettings })));
const OwnerAlerts = lazy(() => import('./OwnerAlerts.js').then((m) => ({ default: m.OwnerAlerts })));
const OwnerInsights = lazy(() => import('./OwnerInsights.js').then((m) => ({ default: m.OwnerInsights })));
const OwnerAlertSettings = lazy(() => import('./OwnerAlertSettings.js').then((m) => ({ default: m.OwnerAlertSettings })));
const OwnerHubSetup = lazy(() => import('./OwnerHubSetup.js').then((m) => ({ default: m.OwnerHubSetup })));
const OwnerSyncProblems = lazy(() => import('./OwnerSyncProblems.js').then((m) => ({ default: m.OwnerSyncProblems })));
const BillHistoryView = lazy(() => import('../../components/BillHistoryView.js').then((m) => ({ default: m.BillHistoryView })));
const OwnerMenu = lazy(() => import('./OwnerMenu.js').then((m) => ({ default: m.OwnerMenu })));
const OwnerTables = lazy(() => import('./OwnerTables.js').then((m) => ({ default: m.OwnerTables })));

const OwnerLoadingFallback: React.FC = () => (
  <div className="p-6 space-y-4 max-w-7xl mx-auto animate-pulse">
    <div className="h-10 w-64 bg-surface-elevated rounded-lg" />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
      <Skeleton variant="rectangular" height={160} />
      <Skeleton variant="rectangular" height={160} />
      <Skeleton variant="rectangular" height={160} />
    </div>
  </div>
);

const OwnerSettings: React.FC = () => (
  <div className="space-y-4 max-w-7xl mx-auto">
    <h2 className="text-title font-bold text-content-primary">Restaurant Settings</h2>
    <EmptyState
      icon={<Settings className="w-8 h-8" />}
      title="Configuration Portal"
      description="GST/VAT tax rules, service charges, currency, and portal device authorizations."
    />
  </div>
);

export default function OwnerPortal(): React.JSX.Element {
  return (
    <ErrorBoundary portalName="Owner Console">
      <Suspense fallback={<OwnerLoadingFallback />}>
        <Routes>
          <Route element={<OwnerLayout />}>
            <Route index element={<OwnerHome />} />
            <Route path="customers" element={<OwnerCustomers />} />
            <Route path="loyalty" element={<OwnerLoyalty />} />
            <Route path="payments" element={<OwnerPaymentsView />} />
            <Route path="bills" element={<BillHistoryView />} />
            <Route path="sales" element={<OwnerSales />} />
            <Route path="close-day" element={<OwnerCloseDay />} />
            <Route path="inventory" element={<OwnerInventory />} />
            <Route path="purchases" element={<OwnerPurchases />} />
            <Route path="expenses" element={<OwnerExpenses />} />
            <Route path="month-review" element={<OwnerMonthReview />} />
            <Route path="health" element={<OwnerHealth />} />
            <Route path="health/settings" element={<OwnerHealthSettings />} />
            <Route path="alerts" element={<OwnerAlerts />} />
            <Route path="alerts/settings" element={<OwnerAlertSettings />} />
            <Route path="insights" element={<OwnerInsights />} />
            <Route path="hub" element={<OwnerHubSetup />} />
            <Route path="sync/problems" element={<OwnerSyncProblems />} />
            <Route
              path="tables"
              element={
                <RequireAuth requiredPermission={Permissions.TABLE_MANAGE}>
                  <OwnerTables />
                </RequireAuth>
              }
            />
            <Route path="menu" element={<OwnerMenu />} />
            <Route path="staff" element={<OwnerStaff />} />
            <Route path="audit" element={<OwnerAudit />} />
            <Route path="settings" element={<OwnerSettings />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
