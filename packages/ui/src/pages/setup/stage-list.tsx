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
import { ChevronRightIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EnforcementBadge } from '@/components/stage-dots';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { StageEditor } from '@/pages/setup/stage-editor';
import { newKey, newStage, type WorkflowDraft } from '@/pages/setup/draft';
import type { StageModel } from '@/lib/types';

interface RowProps {
  id: string;
  stage: StageModel;
  isFresh: boolean;
  otherIds: string[];
  agents: string[];
  rules: { text: string; exists: boolean };
  onChange: (stage: StageModel) => void;
  onRulesChange: (text: string) => void;
  onRemove: () => void;
}

function StageRow({ id, stage, onRemove, ...editor }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-lg border bg-card shadow-xs ${isDragging ? 'z-10 shadow-md' : ''}`}
    >
      <Collapsible>
        <div className="flex items-center gap-1 px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="cursor-grab touch-none"
            aria-label={`Drag to reorder ${stage.name || stage.id}`}
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon />
          </Button>
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left text-sm">
            <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            <span className="truncate font-medium">{stage.name || stage.id || 'New stage'}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{stage.id}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <EnforcementBadge enforcement={stage.enforcement ?? 'guide'} />
              {editor.isFresh && (
                <Badge variant="outline" className="border-primary/40 text-primary">
                  new
                </Badge>
              )}
            </span>
          </CollapsibleTrigger>
          <Button variant="ghost" size="icon-xs" aria-label="Remove stage" onClick={onRemove}>
            <Trash2Icon />
          </Button>
        </div>
        <CollapsibleContent className="border-t p-3">
          <StageEditor stage={stage} {...editor} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** Stage list with drag-to-reorder. Stage ids are editable only for stages added this session. */
export function StageList({
  draft,
  agents,
  rules,
  onChange,
  onRulesChange,
}: {
  draft: WorkflowDraft;
  agents: string[];
  rules: (stageId: string) => { text: string; exists: boolean };
  onChange: (draft: WorkflowDraft) => void;
  onRulesChange: (stageId: string, text: string) => void;
}) {
  const stages = draft.model.stages ?? [];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setStages = (next: StageModel[], keys: string[], fresh = draft.fresh) =>
    onChange({ model: { ...draft.model, stages: next }, keys, fresh });

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = draft.keys.indexOf(String(active.id));
    const to = draft.keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setStages(arrayMove(stages, from, to), arrayMove(draft.keys, from, to));
  };

  const add = () => {
    const key = newKey();
    setStages([...stages, newStage('')], [...draft.keys, key], [...draft.fresh, key]);
  };

  return (
    <div className="flex flex-col gap-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft.keys} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2">
            {stages.map((stage, i) => (
              <StageRow
                key={draft.keys[i]}
                id={draft.keys[i]}
                stage={stage}
                isFresh={draft.fresh.includes(draft.keys[i])}
                otherIds={stages.filter((_, j) => j !== i).map((s) => s.id)}
                agents={agents}
                rules={rules(stage.id)}
                onChange={(s) =>
                  setStages(
                    stages.map((x, j) => (j === i ? s : x)),
                    draft.keys,
                  )
                }
                onRulesChange={(text) => onRulesChange(stage.id, text)}
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
      <div>
        <Button variant="outline" size="sm" onClick={add}>
          <PlusIcon /> Add stage
        </Button>
      </div>
    </div>
  );
}
