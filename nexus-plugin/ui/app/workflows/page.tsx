'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  Node,
  Edge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  Handle,
  Position,
  NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Download,
  Plus,
  Trash2,
  Search,
  AlertTriangle,
  Workflow as WorkflowIcon,
  GripVertical,
} from 'lucide-react';
import { useTriggerApi, Task } from '@/hooks/useTriggerApi';
import { clsx } from 'clsx';

// Custom task node component
function TaskNode({ data }: NodeProps) {
  return (
    <div className="bg-surface-raised border border-border rounded-lg shadow-lg min-w-[180px]">
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-accent !border-accent-hover !w-3 !h-3"
      />
      <div className="px-3 py-2 border-b border-border flex items-center gap-2">
        <GripVertical className="h-3 w-3 text-slate-600" />
        <span className="text-xs font-semibold text-accent truncate">{data.label}</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-xs text-slate-400 truncate">Queue: {data.queue || 'default'}</p>
        <p className="text-xs text-slate-500 truncate">v{data.version || '?'}</p>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-accent !border-accent-hover !w-3 !h-3"
      />
    </div>
  );
}

const nodeTypes = { taskNode: TaskNode };

export default function WorkflowsPage() {
  const { getTasks } = useTriggerApi();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTasks({ limit: 200 });
      setTasks(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [getTasks]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const filteredTasks = useMemo(() => {
    if (!search) return tasks;
    const lower = search.toLowerCase();
    return tasks.filter(
      (t) =>
        t.slug.toLowerCase().includes(lower) ||
        t.queue.toLowerCase().includes(lower) ||
        (t.nexusIntegration || '').toLowerCase().includes(lower)
    );
  }, [tasks, search]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onConnect: OnConnect = useCallback(
    (connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: '#6366f1', strokeWidth: 2 },
          },
          eds
        )
      ),
    []
  );

  const addTaskNode = (task: Task) => {
    const id = `node-${task.id}-${Date.now()}`;
    const existingCount = nodes.length;
    const newNode: Node = {
      id,
      type: 'taskNode',
      position: {
        x: 100 + (existingCount % 4) * 250,
        y: 80 + Math.floor(existingCount / 4) * 180,
      },
      data: {
        label: task.slug,
        queue: task.queue,
        version: task.version,
        taskId: task.id,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
  };

  const exportWorkflow = () => {
    const workflow = {
      name: 'untitled-workflow',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      nodes: nodes.map((n) => ({
        id: n.id,
        taskId: n.data.taskId,
        taskSlug: n.data.label,
        position: n.position,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
    };

    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Workflow Builder</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Drag tasks onto the canvas and connect them to build workflows
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={clearCanvas} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </button>
          <button
            onClick={exportWorkflow}
            disabled={nodes.length === 0}
            className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export JSON
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-4 h-full">
        {/* Task sidebar */}
        <div className="w-64 shrink-0 flex flex-col bg-surface-raised border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-3 border-b border-border">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
              Available Tasks
            </h3>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search tasks..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-field w-full pl-8 !py-1.5 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 bg-surface-overlay rounded animate-pulse" />
              ))
            ) : filteredTasks.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">No tasks found</p>
            ) : (
              filteredTasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => addTaskNode(task)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left hover:bg-surface-overlay transition-colors group"
                >
                  <Plus className="h-3.5 w-3.5 text-slate-600 group-hover:text-accent shrink-0 transition-colors" />
                  <div className="min-w-0">
                    <p className="text-xs text-slate-300 truncate">{task.slug}</p>
                    <p className="text-xs text-slate-600 truncate">{task.queue}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* React Flow canvas */}
        <div className="flex-1 border border-border rounded-lg overflow-hidden bg-surface">
          {nodes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500">
              <WorkflowIcon className="h-16 w-16 mb-4 opacity-30" />
              <p className="text-sm font-medium">Empty Canvas</p>
              <p className="text-xs mt-1">Click tasks from the sidebar to add them to the workflow</p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              className="bg-surface"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#2e3345" gap={20} size={1} />
              <Controls
                className="!bg-surface-raised !border-border !shadow-lg [&>button]:!bg-surface-overlay [&>button]:!border-border [&>button]:!text-slate-400 [&>button:hover]:!bg-surface-raised"
              />
              <MiniMap
                nodeColor="#6366f1"
                maskColor="rgba(15, 17, 23, 0.7)"
                className="!bg-surface-raised !border-border"
              />
            </ReactFlow>
          )}
        </div>
      </div>
    </div>
  );
}
