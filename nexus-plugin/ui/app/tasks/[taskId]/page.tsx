import TaskDetailPage from './task-detail';

export function generateStaticParams() {
  return [{ taskId: '_' }];
}

export default function Page() {
  return <TaskDetailPage />;
}
