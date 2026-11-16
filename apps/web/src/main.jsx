import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

function Protected({ children, perm }) {
  const { me, loading, can } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <Account forced />;
  if (perm && !can(perm)) return <p className="p-6 text-sm text-slate-700">You do not have access to this page.</p>;
  return children;
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
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
