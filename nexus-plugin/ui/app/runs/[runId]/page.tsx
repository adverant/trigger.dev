import RunDetailPage from './run-detail';

export function generateStaticParams() {
  return [{ runId: '_' }];
}

export default function Page() {
  return <RunDetailPage />;
}
