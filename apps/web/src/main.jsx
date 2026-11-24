import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { PageSkeleton } from './components/ui.jsx';
import './i18n.js';
import './index.css';
import Login from './pages/Login.jsx';

// Route-level code splitting keeps the initial bundle small for slow links.
const Home = lazy(() => import('./pages/Home.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const UserDetail = lazy(() => import('./pages/UserDetail.jsx'));
const Roles = lazy(() => import('./pages/Roles.jsx'));
const Facility = lazy(() => import('./pages/Facility.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientRegister = lazy(() => import('./pages/PatientRegister.jsx'));
const PatientDetail = lazy(() => import('./pages/PatientDetail.jsx'));
const PatientCard = lazy(() => import('./pages/PatientCard.jsx'));
const BreakGlassReview = lazy(() => import('./pages/BreakGlassReview.jsx'));
const Queues = lazy(() => import('./pages/Queues.jsx'));
const QueueBoard = lazy(() => import('./pages/QueueBoard.jsx'));
const QueueDisplay = lazy(() => import('./pages/QueueDisplay.jsx'));
const EncounterWorkspace = lazy(() => import('./pages/EncounterWorkspace.jsx'));
const PatientChart = lazy(() => import('./pages/PatientChart.jsx'));
const Bills = lazy(() => import('./pages/Bills.jsx'));
const BillDetail = lazy(() => import('./pages/BillDetail.jsx'));
const BillingSetup = lazy(() => import('./pages/BillingSetup.jsx'));
const Cashier = lazy(() => import('./pages/Cashier.jsx'));
const Receipt = lazy(() => import('./pages/Receipt.jsx'));
const Approvals = lazy(() => import('./pages/Approvals.jsx'));
const FinanceReports = lazy(() => import('./pages/FinanceReports.jsx'));
const Stock = lazy(() => import('./pages/inventory/Stock.jsx'));
const ReceiveGoods = lazy(() => import('./pages/inventory/Receive.jsx'));
const PurchaseOrders = lazy(() => import('./pages/inventory/PurchaseOrders.jsx'));
const InventoryItems = lazy(() => import('./pages/inventory/Items.jsx'));
const Expiry = lazy(() => import('./pages/inventory/Expiry.jsx'));
const Movements = lazy(() => import('./pages/inventory/Movements.jsx'));
const Imaging = lazy(() => import('./pages/Imaging.jsx'));
const Lab = lazy(() => import('./pages/Lab.jsx'));
const LabReport = lazy(() => import('./pages/LabReport.jsx'));
const LabLabels = lazy(() => import('./pages/LabLabels.jsx'));
const Pharmacy = lazy(() => import('./pages/Pharmacy.jsx'));
const Requisitions = lazy(() => import('./pages/inventory/Requisitions.jsx'));
const StockTakes = lazy(() => import('./pages/inventory/StockTakes.jsx'));
const InventoryReports = lazy(() => import('./pages/inventory/InventoryReports.jsx'));

const APPROVER = ['billing.waiver.approve', 'billing.refund.approve', 'billing.payment.receive'];

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

function Protected({ children, perm }) {
  const { me, loading, can, canAny } = useAuth();
  if (loading) return <PageSkeleton />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <Account forced />;
  if (perm && !(Array.isArray(perm) ? canAny(perm) : can(perm)))
    return <p className="p-6 text-sm text-slate-700">You do not have access to this page.</p>;
  return children;
}

function App() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Full-screen waiting-room display, outside the app shell. */}
        <Route
          path="/opd/display/:id"
          element={
            <Protected perm="opd.queue.read">
              <QueueDisplay />
            </Protected>
          }
        />
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route index element={<Home />} />
          <Route
            path="opd"
            element={
              <Protected perm="opd.queue.read">
                <Queues />
              </Protected>
            }
          />
          <Route
            path="opd/queues/:id"
            element={
              <Protected perm="opd.queue.read">
                <QueueBoard />
              </Protected>
            }
          />
          <Route
            path="admin/users"
            element={
              <Protected perm="users.read">
                <Users />
              </Protected>
            }
          />
          <Route
            path="admin/users/:id"
            element={
              <Protected perm="users.read">
                <UserDetail />
              </Protected>
            }
          />
          <Route
            path="admin/roles"
            element={
              <Protected perm="roles.read">
                <Roles />
              </Protected>
            }
          />
          <Route
            path="admin/facility"
            element={
              <Protected perm="facilities.read">
                <Facility />
              </Protected>
            }
          />
          <Route
            path="admin/audit"
            element={
              <Protected perm="audit.read">
                <Audit />
              </Protected>
            }
          />
          <Route
            path="patients"
            element={
              <Protected perm="patients.read">
                <Patients />
              </Protected>
            }
          />
          <Route
            path="patients/new"
            element={
              <Protected perm="patients.create">
                <PatientRegister />
              </Protected>
            }
          />
          <Route
            path="patients/:id"
            element={
              <Protected perm="patients.read">
                <PatientDetail />
              </Protected>
            }
          />
          <Route
            path="patients/:id/card"
            element={
              <Protected perm="patients.read">
                <PatientCard />
              </Protected>
            }
          />
          <Route
            path="patients/:id/chart"
            element={
              <Protected perm="emr.read">
                <PatientChart />
              </Protected>
            }
          />
          <Route
            path="encounters/:id"
            element={
              <Protected perm="emr.read">
                <EncounterWorkspace />
              </Protected>
            }
          />
          <Route
            path="billing"
            element={
              <Protected perm="billing.read">
                <Bills />
              </Protected>
            }
          />
          <Route
            path="billing/bills/:id"
            element={
              <Protected perm="billing.read">
                <BillDetail />
              </Protected>
            }
          />
          <Route
            path="billing/setup"
            element={
              <Protected perm="billing.pricelist.manage">
                <BillingSetup />
              </Protected>
            }
          />
          <Route
            path="cashier"
            element={
              <Protected perm="billing.shift.manage">
                <Cashier />
              </Protected>
            }
          />
          <Route
            path="billing/receipts/:id"
            element={
              <Protected perm="billing.read">
                <Receipt />
              </Protected>
            }
          />
          <Route
            path="imaging"
            element={
              <Protected perm="imaging.read">
                <Imaging />
              </Protected>
            }
          />
          <Route
            path="lab"
            element={
              <Protected perm="lab.read">
                <Lab />
              </Protected>
            }
          />
          <Route
            path="lab/report/:id"
            element={
              <Protected perm={['lab.read', 'emr.read']}>
                <LabReport />
              </Protected>
            }
          />
          <Route
            path="lab/labels"
            element={
              <Protected perm={['lab.samples.collect', 'lab.read']}>
                <LabLabels />
              </Protected>
            }
          />
          <Route
            path="pharmacy"
            element={
              <Protected perm="pharmacy.read">
                <Pharmacy />
              </Protected>
            }
          />
          <Route
            path="inventory"
            element={
              <Protected perm="inventory.read">
                <Stock />
              </Protected>
            }
          />
          <Route
            path="inventory/receive"
            element={
              <Protected perm="inventory.receive">
                <ReceiveGoods />
              </Protected>
            }
          />
          <Route
            path="inventory/purchase-orders"
            element={
              <Protected perm="inventory.read">
                <PurchaseOrders />
              </Protected>
            }
          />
          <Route
            path="inventory/items"
            element={
              <Protected perm="inventory.read">
                <InventoryItems />
              </Protected>
            }
          />
          <Route
            path="inventory/expiry"
            element={
              <Protected perm="inventory.read">
                <Expiry />
              </Protected>
            }
          />
          <Route
            path="inventory/movements"
            element={
              <Protected perm="inventory.read">
                <Movements />
              </Protected>
            }
          />
          <Route
            path="inventory/requisitions"
            element={
              <Protected perm="inventory.read">
                <Requisitions />
              </Protected>
            }
          />
          <Route
            path="inventory/stock-takes"
            element={
              <Protected perm="inventory.read">
                <StockTakes />
              </Protected>
            }
          />
          <Route
            path="inventory/reports"
            element={
              <Protected perm={['reports.operational.read', 'reports.financial.read']}>
                <InventoryReports />
              </Protected>
            }
          />
          <Route
            path="reports/finance"
            element={
              <Protected perm="reports.financial.read">
                <FinanceReports />
              </Protected>
            }
          />
          <Route
            path="billing/approvals"
            element={
              <Protected perm={APPROVER}>
                <Approvals />
              </Protected>
            }
          />
          <Route
            path="admin/break-glass"
            element={
              <Protected perm="audit.read">
                <BreakGlassReview />
              </Protected>
            }
          />
          <Route path="account" element={<Account />} />
          <Route path="*" element={<p className="p-6 text-sm">Page not found.</p>} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
