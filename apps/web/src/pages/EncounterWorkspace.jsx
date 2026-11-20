import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ageParts } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import DiagnosesPanel from '../components/emr/DiagnosesPanel.jsx';
import NotesPanel from '../components/emr/NotesPanel.jsx';
import PrescriptionsPanel from '../components/emr/PrescriptionsPanel.jsx';
import VitalsPanel from '../components/emr/VitalsPanel.jsx';
import PatientBanner from '../components/PatientBanner.jsx';
import { Alert, Badge, ErrorMessage, PageHeader, Spinner, formatDateTime, PageSkeleton } from '../components/ui.jsx';
import { usePatient } from './PatientDetail.jsx';

/** One visit's clinical workspace: vitals, notes, diagnoses and prescriptions. */
export default function EncounterWorkspace() {
  const { id } = useParams();
  const qc = useQueryClient();
  const visit = useQuery({ queryKey: ['encounter', id], queryFn: () => api.get(`/encounters/${id}`) });
  const patient = usePatient(visit.data?.patient.id);
  const clinical = useQuery({
    queryKey: ['clinical', id],
    queryFn: () => api.get(`/encounters/${id}/clinical`),
    enabled: !!patient.data?.clinical?.canView,
    retry: false,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['clinical', id] });
    qc.invalidateQueries({ queryKey: ['patient', visit.data?.patient.id] });
  };

  if (visit.isPending || (visit.data && patient.isPending)) return <PageSkeleton />;
  if (visit.error) return <ErrorMessage error={visit.error} />;
  if (patient.error) return <ErrorMessage error={patient.error} />;
  const v = visit.data;
  const p = patient.data;

  return (
    <>
      <PatientBanner patient={p} />
      <PageHeader
        title="Visit"
        description={
          <>
            <Badge tone={v.type === 'emergency' ? 'red' : 'teal'}>{v.type}</Badge> started {formatDateTime(v.startedAt)}{' '}
            · {v.schemeName ?? 'Cash'} · {v.status}
            {v.currentTicket && ` · now at ${v.currentTicket.servicePointName}`}
          </>
        }
        actions={
          <>
            <Link to={`/patients/${p.id}/chart`} className="btn-secondary">
              Full chart
            </Link>
            {v.currentTicket && (
              <Can perm="opd.queue.read">
                <Link to={`/opd/queues/${v.currentTicket.queueId}`} className="btn-secondary">
                  {v.currentTicket.queueName} queue
                </Link>
              </Can>
            )}
          </>
        }
      />
      {!p.clinical.canView ? (
        <Alert kind="warn">
          {p.clinical.reason === 'restricted'
            ? 'This record is restricted. Use emergency access in the banner above if you need it.'
            : 'Your role does not include access to clinical records.'}
        </Alert>
      ) : clinical.isPending ? (
        <Spinner />
      ) : clinical.error ? (
        <ErrorMessage error={clinical.error} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <VitalsPanel
            encounterId={id}
            ageMonths={ageParts(p.dateOfBirth).months}
            vitals={clinical.data.vitals}
            onChange={refresh}
          />
          <DiagnosesPanel encounterId={id} diagnoses={clinical.data.diagnoses} onChange={refresh} />
          <div className="xl:col-span-2">
            <NotesPanel encounterId={id} notes={clinical.data.notes} onChange={refresh} />
          </div>
          <div className="xl:col-span-2">
            <PrescriptionsPanel encounterId={id} />
          </div>
        </div>
      )}
    </>
  );
}
