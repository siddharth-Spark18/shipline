import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EnforcementBadge } from '@/components/stage-dots';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { newKey, newStage, type WorkflowDraft } from '@/pages/setup/draft';
import type { StageModel } from '@/lib/types';

interface RowProps {
  id: string;
  stage: StageModel;
  isFresh: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

/** One read-only stage: handle, name, enforcement, tags, then up, down, a menu and Edit. */
function StageRow({ id, stage, isFresh, first, last, onEdit, onMove, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const label = stage.name || stage.id || 'New stage';
  const tags = [
    stage.confirm_to_advance ? 'confirm' : null,
    stage.checkpoint ? 'checkpoint' : null,
    stage.agent ?? null,
  ].filter(Boolean);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 bg-card px-2 py-2 md:flex-nowrap ${isDragging ? 'relative z-10 shadow-md' : ''}`}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="cursor-grab touch-none max-md:size-11"
        aria-label={`Drag to reorder ${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon />
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:w-36 md:flex-none md:flex-row md:items-center md:gap-2">
        <span className="truncate text-sm font-semibold">{label}</span>
        {isFresh && (
          <Badge variant="outline" className="w-fit border-primary/40 text-primary">
            new
          </Badge>
        )}
      </div>
      <EnforcementBadge enforcement={stage.enforcement ?? 'guide'} />
      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">
        {tags.join(' · ')}
      </span>
      <span className="order-last w-full pl-1 text-xs text-muted-foreground md:hidden">
        {tags.join(' · ')}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          className="max-md:size-11"
          aria-label={`Move ${label} up`}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="max-md:size-11"
          aria-label={`Move ${label} down`}
          disabled={last}
          onClick={() => onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="max-md:size-11"
              aria-label={`More for ${label}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2Icon /> Delete stage
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onEdit}>
          Edit
        </Button>
      </div>
    </li>
  );
}

/**
 * The workflow's stages as read-only rows with drag-to-reorder (and up/down buttons for keyboard and phone). Edit opens
 * the stage's own page. Stage ids are editable only for stages added this session, on that page.
 */
export function StageList({
  draft,
  onChange,
  onEdit,
  onAdded,
}: {
  draft: WorkflowDraft;
  onChange: (draft: WorkflowDraft) => void;
  /** Open the page of the stage at this 1-based position. */
  onEdit: (n: number) => void;
  /** Called after "Add stage" added one, with its 1-based position (the page then opens it). */
  onAdded: (n: number) => void;
}) {
  const stages = draft.model.stages ?? [];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setStages = (next: StageModel[], keys: string[], fresh = draft.fresh) =>
    onChange({ model: { ...draft.model, stages: next }, keys, fresh });

  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || from >= stages.length || to >= stages.length || from === to) return;
    setStages(arrayMove(stages, from, to), arrayMove(draft.keys, from, to));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(draft.keys.indexOf(String(active.id)), draft.keys.indexOf(String(over.id)));
  };

  const add = () => {
    const key = newKey();
    setStages([...stages, newStage('')], [...draft.keys, key], [...draft.fresh, key]);
    onAdded(stages.length + 1);
  };

  return (
    <div className="flex flex-col gap-3">
      {stages.length === 0 ? (
        <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">
          This workflow has no stages yet.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={draft.keys} strategy={verticalListSortingStrategy}>
            <ol className="divide-y overflow-hidden rounded-xl border bg-card">
              {stages.map((stage, i) => (
                <StageRow
                  key={draft.keys[i]}
                  id={draft.keys[i]}
                  stage={stage}
                  isFresh={draft.fresh.includes(draft.keys[i])}
                  first={i === 0}
                  last={i === stages.length - 1}
                  onEdit={() => onEdit(i + 1)}
                  onMove={(by) => move(i, i + by)}
                  onRemove={() =>
                    setStages(
                      stages.filter((_, j) => j !== i),
                      draft.keys.filter((_, j) => j !== i),
                      draft.fresh.filter((k) => k !== draft.keys[i]),
                    )
                  }
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <div>
        <Button variant="outline" className="max-md:h-11" onClick={add}>
          <PlusIcon /> Add stage
        </Button>
      </div>
    </div>
  );
}
