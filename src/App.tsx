import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import tasksData from './tasks.json';

type Status = 'Backlog' | 'In Progress' | 'Review' | 'Done';
type NavView = 'Overview' | 'Sprint Board' | 'Reports' | 'Teams' | 'Calendar';

type Task = {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  dueDate?: string;
  completedDate?: string;
  estimateHours?: number | string;
  createdAt?: string;
  priority?: string;
  warning?: boolean;
  repair?: boolean;
};

const STATUS_ORDER: Status[] = ['Backlog', 'In Progress', 'Review', 'Done'];
const WIP_LIMITS: Record<Exclude<Status, 'Backlog'>, number> = {
  'In Progress': 5,
  Review: 3,
  Done: 999,
};

const normalizeStatus = (value: string): Status => {
  if (value === 'In Progress' || value === 'Review' || value === 'Done' || value === 'Backlog') return value as Status;
  return 'Backlog';
};

const normalizeAssignee = (value: unknown) => {
  if (typeof value !== 'string') return 'Unassigned';
  const cleaned = value.trim();
  if (!cleaned || /^(n\/a)$/i.test(cleaned)) return 'Unassigned';
  return cleaned;
};

const normalizeEstimate = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
};

const parseDate = (value?: string) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return new Date(trimmed + 'T00:00:00');
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [d, m, y] = trimmed.split('/').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(trimmed);
};

const isValidDate = (value?: string) => !Number.isNaN(parseDate(value)?.getTime());

const cleanTasks = (raw: any[]): { tasks: Task[]; issuesFixed: number } => {
  const tasks: Task[] = [];
  let issuesFixed = 0;

  const deduped = new Map<string, any>();
  raw.forEach((item, index) => {
    const id = String(item?.id ?? `temp-${index}`);
    deduped.set(id, item);
  });

  const seenIds = new Set<string>();
  deduped.forEach((item, id) => {
    const originalStatus = String(item?.status ?? 'Backlog');
    const status = normalizeStatus(originalStatus);
    const estimateRaw = item?.estimateHours;
    const estimate = normalizeEstimate(estimateRaw);
    const invalidEstimate = !(/^-?\d+(\.\d+)?$/.test(String(estimateRaw).trim()) && Number(estimateRaw) >= 0) && !(typeof estimateRaw === 'number' && estimateRaw >= 0);
    const invalidAssignee = item?.assignee === null || item?.assignee === '' || /^(n\/a)$/i.test(String(item?.assignee ?? '')) || String(item?.assignee ?? '').trim() === '';
    const invalidStatus = originalStatus !== status;
    const isDuplicate = raw.filter((entry) => String(entry?.id ?? '') === id).length > 1;

    if (isDuplicate) issuesFixed += 1;
    if (invalidStatus) issuesFixed += 1;
    if (invalidAssignee) issuesFixed += 1;
    if (invalidEstimate) issuesFixed += 1;

    tasks.push({
      id,
      title: String(item?.title ?? 'Untitled task'),
      status,
      assignee: normalizeAssignee(item?.assignee),
      dueDate: isValidDate(item?.dueDate) ? item?.dueDate : undefined,
      completedDate: isValidDate(item?.completedDate) ? item?.completedDate : undefined,
      estimateHours: estimate,
      createdAt: item?.createdAt,
      priority: item?.priority,
      warning: invalidStatus,
      repair: invalidEstimate,
    });

    seenIds.add(id);
  });

  return { tasks, issuesFixed };
};

const getWeekCompletedHours = (tasks: Task[]) => {
  const now = new Date();
  const day = now.getDay();
  const diff = (day + 6) % 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - diff);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return tasks.filter((task) => task.status === 'Done' && task.completedDate && parseDate(task.completedDate)! >= monday && parseDate(task.completedDate)! <= sunday).reduce((sum, task) => sum + Number(task.estimateHours || 0), 0);
};

export default function App() {
  const { tasks: importedTasks, issuesFixed } = cleanTasks((tasksData as any[]).flat() || []);
  const [tasks, setTasks] = useState<Task[]>(importedTasks);
  const [query, setQuery] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<'All' | Status>('All');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingOver, setDraggingOver] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<NavView>('Overview');
  const [history, setHistory] = useState<Task[][]>([importedTasks]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [message, setMessage] = useState('');
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('appzeto-sprint-board');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Task[];
        if (Array.isArray(parsed) && parsed.length) {
          setTasks(parsed);
          setHistory([parsed]);
          setHistoryIndex(0);
        }
      } catch {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('appzeto-sprint-board', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [historyIndex, history]);

  const saveHistory = (next: Task[]) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(next);
    setHistory(newHistory.slice(-10));
    setHistoryIndex(newHistory.length - 1);
    setTasks(next);
  };

  const undo = () => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setTasks(prev);
    }
  };

  const redo = () => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setTasks(next);
    }
  };

  const assignees = useMemo(() => Array.from(new Set(tasks.map((t) => t.assignee).filter((value): value is string => Boolean(value)))).sort(), [tasks]);

  const viewCopy: Record<NavView, { eyebrow: string; title: string; description: string }> = {
    Overview: { eyebrow: 'Sprint Operations', title: 'Appzeto Sprint Board', description: 'Track delivery, review queue health, and team throughput from one focused workspace.' },
    'Sprint Board': { eyebrow: 'Board Focus', title: 'Sprint Board', description: 'Drag cards across the flow and keep work moving with live WIP checks.' },
    Reports: { eyebrow: 'Insights', title: 'Reports', description: 'See overdue work, completion pace, and effort distribution by team.' },
    Teams: { eyebrow: 'People', title: 'Teams', description: 'Monitor who is owning what and which collaborators need support.' },
    Calendar: { eyebrow: 'Timeline', title: 'Calendar', description: 'Plan around due dates and upcoming milestones from the current sprint.' },
  };

  const upcomingTasks = useMemo(
    () => tasks.filter((task) => task.dueDate).sort((a, b) => (parseDate(a.dueDate)!?.getTime() ?? 0) - (parseDate(b.dueDate)!?.getTime() ?? 0)).slice(0, 12),
    [tasks]
  );

  const calendarDays = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDay = (firstDay.getDay() + 6) % 7;
    const cells: Array<{ date: Date; day: number; isCurrentMonth: boolean; tasks: Task[] }> = [];

    for (let i = 0; i < startDay; i += 1) {
      const date = new Date(year, month, i - startDay + 1);
      cells.push({ date, day: date.getDate(), isCurrentMonth: false, tasks: tasks.filter((task) => task.dueDate && parseDate(task.dueDate)?.toDateString() === date.toDateString()) });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      cells.push({ date, day, isCurrentMonth: true, tasks: tasks.filter((task) => task.dueDate && parseDate(task.dueDate)?.toDateString() === date.toDateString()) });
    }

    while (cells.length % 7 !== 0) {
      const date = new Date(year, month, cells[cells.length - 1].day + 1);
      cells.push({ date, day: date.getDate(), isCurrentMonth: false, tasks: tasks.filter((task) => task.dueDate && parseDate(task.dueDate)?.toDateString() === date.toDateString()) });
    }

    return cells;
  }, [tasks]);

  const summaryCards = useMemo(() => {
    const overdueCount = tasks.filter((task) => task.status !== 'Done' && task.dueDate && parseDate(task.dueDate)! < new Date()).length;
    const activeCount = tasks.filter((task) => task.status === 'In Progress').length;
    const reviewCount = tasks.filter((task) => task.status === 'Review').length;
    const doneCount = tasks.filter((task) => task.status === 'Done').length;
    const totalCount = tasks.length;
    const totalHours = tasks.reduce((sum, task) => sum + Number(task.estimateHours || 0), 0);
    const completionPct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
    return [
      { label: 'Active sprint', value: `${activeCount} cards`, accent: 'cyan' },
      { label: 'Overdue focus', value: `${overdueCount} tasks`, accent: 'rose' },
      { label: 'Review queue', value: `${reviewCount} cards`, accent: 'amber' },
      { label: 'Total effort', value: `${totalHours}h`, accent: 'emerald' },
    ];
  }, [tasks]);

  const progressChartData = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((task) => task.status === 'Done').length;
    const remaining = Math.max(total - done, 0);
    return [
      { name: 'Completed', value: done, color: '#34d399' },
      { name: 'Remaining', value: remaining, color: '#38bdf8' },
    ];
  }, [tasks]);

  const analyticsCards = useMemo(() => {
    const totalCount = tasks.length;
    const completedCount = tasks.filter((task) => task.status === 'Done').length;
    const overdueCount = tasks.filter((task) => task.status !== 'Done' && task.dueDate && parseDate(task.dueDate)! < new Date()).length;
    const completionPct = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
    const totalHours = tasks.reduce((sum, task) => sum + Number(task.estimateHours || 0), 0);

    return [
      { label: 'Total Tasks', value: String(totalCount), accent: 'cyan' },
      { label: 'Completed Tasks', value: String(completedCount), accent: 'emerald' },
      { label: 'Overdue Tasks', value: String(overdueCount), accent: 'rose' },
      { label: 'Completion %', value: `${completionPct}%`, accent: 'amber' },
      { label: 'Total Estimated Hours', value: `${totalHours}h`, accent: 'indigo' },
    ];
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesQuery = !q || task.title.toLowerCase().includes(q);
      const matchesAssignee = assigneeFilter.length === 0 || assigneeFilter.includes(task.assignee || 'Unassigned');
      const matchesStatus = statusFilter === 'All' || task.status === statusFilter;
      const due = task.dueDate ? parseDate(task.dueDate)! : null;
      const overdue = due ? due < new Date() && task.status !== 'Done' : false;
      return matchesQuery && matchesAssignee && matchesStatus && (!overdueOnly || overdue);
    });
  }, [tasks, query, assigneeFilter, statusFilter, overdueOnly]);

  const moveTask = (taskId: string, targetStatus: Status, targetIndex: number) => {
    const current = tasks.find((task) => task.id === taskId);
    if (!current) return;

    const currentStatus = current.status as Status;
    const currentIndex = tasks.findIndex((task) => task.id === taskId);
    const next = [...tasks];
    const [moved] = next.splice(currentIndex, 1);
    moved.status = targetStatus;
    next.splice(targetIndex, 0, moved);

    if (targetStatus === 'In Progress' && countStatus(next, 'In Progress') > WIP_LIMITS['In Progress']) {
      setMessage('WIP limit reached for In Progress.');
      return;
    }
    if (targetStatus === 'Review' && countStatus(next, 'Review') > WIP_LIMITS.Review) {
      setMessage('WIP limit reached for Review.');
      return;
    }

    saveHistory(next);
  };

  const countStatus = (list: Task[], status: Status) => list.filter((t) => t.status === status).length;

  const totalHours = (status: Status) => tasks.filter((t) => t.status === status).reduce((sum, task) => sum + Number(task.estimateHours || 0), 0);

  const handleDrop = (status: Status, index: number) => {
    if (!draggingId) return;
    const current = tasks.find((task) => task.id === draggingId);
    if (!current) return;
    const sameStatus = current.status === status;
    if (sameStatus) {
      const currentIndex = tasks.findIndex((task) => task.id === draggingId);
      const next = [...tasks];
      const [moved] = next.splice(currentIndex, 1);
      next.splice(index, 0, moved);
      saveHistory(next);
    } else {
      moveTask(draggingId, status, index);
    }
    setDraggingId(null);
    setDraggingOver(null);
  };

  const resetBoard = () => {
    const original = importedTasks;
    setTasks(original);
    setHistory([original]);
    setHistoryIndex(0);
    localStorage.setItem('appzeto-sprint-board', JSON.stringify(original));
  };

  const suggestNextTask = () => {
    const now = new Date();
    const nextTask = tasks
      .filter((task) => task.status !== 'Done')
      .sort((a, b) => {
        const aOverdue = Boolean(a.dueDate && parseDate(a.dueDate)! < now);
        const bOverdue = Boolean(b.dueDate && parseDate(b.dueDate)! < now);

        if (aOverdue !== bOverdue) {
          return Number(bOverdue) - Number(aOverdue);
        }

        const aReview = a.status === 'Review' ? 0 : 1;
        const bReview = b.status === 'Review' ? 0 : 1;
        if (aReview !== bReview) {
          return aReview - bReview;
        }

        return (parseDate(a.dueDate)!?.getTime() ?? Number.POSITIVE_INFINITY) - (parseDate(b.dueDate)!?.getTime() ?? Number.POSITIVE_INFINITY);
      })[0];

    if (!nextTask) {
      setMessage('No actionable tasks available right now.');
      return;
    }

    setMessage(`Suggested next task: ${nextTask.title} (${nextTask.status})${nextTask.dueDate ? ` · due ${nextTask.dueDate}` : ''}`);
    setActiveView('Sprint Board');
  };

  const showOverviewContent = activeView === 'Overview';
  const showBoardContent = activeView === 'Overview' || activeView === 'Sprint Board';

  return (
    <div className="app-shell min-h-screen bg-[radial-gradient(circle_at_top,_#172554_0%,_#0b1220_35%,_#050b14_100%)] text-slate-100">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-6%] top-[-8%] h-52 w-52 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute right-[-8%] top-10 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-emerald-400/10 blur-3xl" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="relative z-10"
      >
      <div className="dashboard-shell">
        <aside className="side-rail rounded-3xl border border-white/10 bg-slate-950/70 shadow-glow backdrop-blur-xl">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>Appzeto</h2>
          </div>
          <nav className="side-nav">
            {(['Overview', 'Sprint Board', 'Reports', 'Teams', 'Calendar'] as const).map((item) => (
              <button
                key={item}
                className={`nav-pill ${activeView === item ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveView(item)}
              >
                {item}
              </button>
            ))}
          </nav>
          <div className="side-card">
            <p>Today</p>
            <strong>3 priority tasks</strong>
            <span>Keep the review queue moving.</span>
          </div>
        </aside>

        <main className="main-panel">
          <header className="hero-card rounded-3xl border border-white/10 bg-slate-950/70 p-6 shadow-glow backdrop-blur-xl">
            <div className="hero-copy">
              <p className="eyebrow">{viewCopy[activeView].eyebrow}</p>
              <h1>{viewCopy[activeView].title}</h1>
              <p className="subtle">{viewCopy[activeView].description}</p>
            </div>
            <aside className="hero-panel">
              <div className="mini-chip">Sprint health 92%</div>
              <div className="mini-chip health">Data Health {issuesFixed} issues fixed · {tasks.length} tasks loaded</div>
              <div className="mini-chip accent">Velocity 18 pts</div>
              <div className="mini-chip soft">Focus: Delivery + QA</div>
              <button className="ghost-btn" onClick={suggestNextTask}>Suggest Next Task</button>
              <button className="ghost-btn" onClick={resetBoard}>Reset board</button>
            </aside>
          </header>

          {showOverviewContent ? (
            <>
              <section className="rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-glow backdrop-blur-xl">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="eyebrow">Progress</p>
                    <h2 className="m-0 text-xl text-white">Burn-down / Progress Chart</h2>
                  </div>
                  <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.25em] text-cyan-100">Live</span>
                </div>
                <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
                  <div className="h-56 rounded-2xl border border-white/10 bg-slate-900/80 p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={progressChartData}>
                        <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                        <XAxis dataKey="name" tick={{ fill: '#cbd5e1', fontSize: 12 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#cbd5e1', fontSize: 12 }} axisLine={false} tickLine={false} />
                        <Tooltip cursor={{ fill: 'rgba(56,189,248,0.08)' }} contentStyle={{ backgroundColor: 'rgba(15,23,42,0.96)', border: '1px solid rgba(148,163,184,0.18)', borderRadius: 14 }} />
                        <Bar dataKey="value" radius={[10, 10, 0, 0]}>
                          {progressChartData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="grid gap-3">
                    {progressChartData.map((entry) => (
                      <article key={entry.name} className="rounded-2xl border border-white/10 bg-slate-900/80 p-4">
                        <p className="eyebrow">{entry.name}</p>
                        <strong className="text-2xl text-white">{entry.value}</strong>
                        <p className="muted">Tasks in the current sprint flow.</p>
                      </article>
                    ))}
                  </div>
                </div>
              </section>

              <section className="stats-grid">
                {summaryCards.map((item, index) => (
                  <motion.article
                    key={item.label}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, delay: 0.02 * index }}
                    className={`stat-card ${item.accent}`}
                  >
                    <p>{item.label}</p>
                    <strong>{item.value}</strong>
                  </motion.article>
                ))}
              </section>
            </>
          ) : null}

          {activeView === 'Reports' ? (
            <section className="toolbar-card rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-glow backdrop-blur-xl">
              <div className="grid gap-4 md:grid-cols-3">
                <article className="rounded-2xl border border-cyan-400/20 bg-slate-900/80 p-4">
                  <p className="eyebrow">Overdue</p>
                  <strong className="text-2xl text-white">{tasks.filter((task) => task.status !== 'Done' && task.dueDate && parseDate(task.dueDate)! < new Date()).length}</strong>
                  <p className="muted">Tasks needing immediate attention.</p>
                </article>
                <article className="rounded-2xl border border-emerald-400/20 bg-slate-900/80 p-4">
                  <p className="eyebrow">Done this week</p>
                  <strong className="text-2xl text-white">{getWeekCompletedHours(tasks)}h</strong>
                  <p className="muted">Completion effort in the current week.</p>
                </article>
                <article className="rounded-2xl border border-amber-400/20 bg-slate-900/80 p-4">
                  <p className="eyebrow">Top assignee</p>
                  <strong className="text-2xl text-white">{assignees[0] || 'Unassigned'}</strong>
                  <p className="muted">Most active owner in the active sprint.</p>
                </article>
              </div>
            </section>
          ) : null}

          {activeView === 'Teams' ? (
            <section className="toolbar-card rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-glow backdrop-blur-xl">
              <div className="grid gap-4 md:grid-cols-2">
                {assignees.length ? assignees.map((person) => (
                  <article key={person} className="rounded-2xl border border-white/10 bg-slate-900/80 p-4">
                    <p className="eyebrow">Owner</p>
                    <strong className="text-xl text-white">{person}</strong>
                    <p className="muted">{tasks.filter((task) => task.assignee === person).length} active tasks in motion.</p>
                  </article>
                )) : <p className="muted">No assignees available yet.</p>}
              </div>
            </section>
          ) : null}

          {activeView === 'Calendar' ? (
            <section className="toolbar-card rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-glow backdrop-blur-xl">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="eyebrow">Sprint timeline</p>
                  <h2 className="m-0 text-xl text-white">Calendar view</h2>
                </div>
                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs uppercase tracking-[0.25em] text-cyan-100">Due dates</span>
              </div>

              <div className="grid gap-3 md:grid-cols-[1fr_280px]">
                <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-3">
                  <div className="mb-2 grid grid-cols-7 gap-2 text-[11px] uppercase tracking-[0.25em] text-slate-300">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day} className="text-center">{day}</span>)}
                  </div>
                  <div className="grid grid-cols-7 gap-2">
                    {calendarDays.map((cell) => (
                      <article key={`${cell.date.toISOString()}-${cell.day}`} className={`rounded-2xl border p-2 min-h-[88px] ${cell.isCurrentMonth ? 'border-white/10 bg-slate-950/80' : 'border-white/5 bg-slate-950/40 opacity-70'}`}>
                        <div className="mb-1 flex items-center justify-between text-[11px] text-slate-300">
                          <span>{cell.day}</span>
                          {cell.tasks.length ? <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-cyan-100">{cell.tasks.length}</span> : null}
                        </div>
                        <div className="space-y-1">
                          {cell.tasks.slice(0, 2).map((task) => (
                            <p key={task.id} className="rounded-md bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-50">{task.title}</p>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>

                <aside className="space-y-3">
                  {upcomingTasks.length ? upcomingTasks.map((task) => (
                    <article key={task.id} className="rounded-2xl border border-white/10 bg-slate-900/80 p-4">
                      <strong className="text-white">{task.title}</strong>
                      <p className="muted">Due {task.dueDate || '—'} · {task.assignee || 'Unassigned'}</p>
                    </article>
                  )) : <p className="muted">No upcoming due dates in the current dataset.</p>}
                </aside>
              </div>
            </section>
          ) : null}

          {showBoardContent ? (
            <section className="toolbar-card rounded-3xl border border-white/10 bg-slate-950/70 p-5 shadow-glow backdrop-blur-xl">
              <div className="toolbar-grid">
                <label className="field">
                  <span>Search title</span>
                  <input value={query} onChange={(e) => {
                    const next = e.target.value;
                    if (debounceRef.current) window.clearTimeout(debounceRef.current);
                    debounceRef.current = window.setTimeout(() => setQuery(next), 300);
                  }} placeholder="Type task name" />
                </label>
                <label className="field">
                  <span>Assignee</span>
                  <select multiple value={assigneeFilter} onChange={(e) => setAssigneeFilter(Array.from(e.target.selectedOptions, (o) => o.value))}>
                    {assignees.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
                  </select>
                </label>
                <label className="chip-row">
                  <input type="checkbox" checked={overdueOnly} onChange={() => setOverdueOnly((v) => !v)} />
                  <span>Overdue only</span>
                </label>
              </div>
              <div className="chip-bar">
                {(['All', 'Backlog', 'In Progress', 'Review', 'Done'] as const).map((chip) => (
                  <button
                    key={chip}
                    className={`chip ${statusFilter === chip ? 'active' : ''}`}
                    onClick={() => setStatusFilter(chip)}
                    type="button"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <p className="tiny">Filters are visual only. WIP limits and totals always use the full dataset.</p>
              {message ? <p className="toast">{message}</p> : null}
            </section>
          ) : null}

          <section className="board-grid">
            {STATUS_ORDER.map((status) => (
              <motion.article
                key={status}
                layout
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.05 * STATUS_ORDER.indexOf(status) }}
                className={`column ${draggingOver === status ? 'drop-target' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDraggingOver(status); }}
                onDragLeave={() => setDraggingOver(null)}
                onDrop={(e) => { e.preventDefault(); handleDrop(status, tasks.filter((t) => t.status === status).length); }}
              >
                <header className="column-header">
                  <div>
                    <h2>{status}</h2>
                    <p>{countStatus(tasks, status)} cards · {totalHours(status)}h</p>
                  </div>
                  {status === 'Done' ? <span className="badge">{getWeekCompletedHours(tasks)}h this week</span> : null}
                </header>
                <div className="card-stack">
                  {filteredTasks.filter((task) => task.status === status).map((task, index) => (
                    <motion.div
                      key={task.id}
                      draggable
                      onDragStart={() => setDraggingId(task.id)}
                      onDragEnd={() => { setDraggingId(null); setDraggingOver(null); }}
                      onDrop={(e) => { e.preventDefault(); handleDrop(status, index); }}
                      whileHover={{ y: -4, scale: 1.01 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                      className={`task-card ${draggingId === task.id ? 'dragging' : ''}`}
                    >
                      <div className="card-top">
                        <strong>{task.title}</strong>
                        <span className="badge">{task.estimateHours}h</span>
                      </div>
                      <p className="muted">Assignee: {task.assignee || 'Unassigned'}</p>
                      <p className="muted">Due: {task.dueDate || '—'}</p>
                      {task.warning ? <p className="warning">Status was repaired to Backlog</p> : null}
                      {task.repair ? <p className="warning">Estimate repaired to 0</p> : null}
                    </motion.div>
                  ))}
                </div>
              </motion.article>
            ))}
          </section>

          <section className="footer-note">Tip: drag cards into columns, use Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z for history, and refresh to keep the layout.</section>
          <motion.section
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="rounded-3xl border border-white/10 bg-slate-950/70 p-4 shadow-glow backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="eyebrow">Motion system</p>
                <h3 className="m-0 text-xl text-slate-100">Premium sprint interactions</h3>
              </div>
              <div className="h-16 w-40 rounded-2xl border border-cyan-400/20 bg-[linear-gradient(135deg,rgba(56,189,248,0.14),rgba(99,102,241,0.16))] shadow-glow" />
            </div>
          </motion.section>
        </main>
      </div>
      </motion.div>
    </div>
  );
}
