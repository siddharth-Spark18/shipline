import { useRef, type ChangeEvent } from 'react';
import { PaperclipIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImageData } from '@/lib/types';

export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;
export const IMAGE_RULE = 'Only PNG, JPEG, GIF or WebP up to 5 MB, 5 per message';

/** An image attached to the message being written. */
export interface Attachment extends ImageData {
  id: string;
  name: string;
}

export const imageSrc = (img: ImageData) => `data:${img.media_type};base64,${img.data}`;

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      // "data:<type>;base64,<data>": the server wants the data alone.
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

let seq = 0;

/**
 * Checks and reads files. Valid ones come back as attachments (up to the room left); the refused
 * ones come back as one message listing them, so nothing is silently dropped.
 */
export async function readImages(
  files: File[],
  alreadyAttached: number,
): Promise<{ added: Attachment[]; error: string | null }> {
  const added: Attachment[] = [];
  const refused: string[] = [];
  let tooMany = 0;
  for (const file of files) {
    const name = file.name || 'image';
    if (!ALLOWED_TYPES.includes(file.type)) {
      refused.push(`${name} (not PNG, JPEG, GIF or WebP)`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      refused.push(`${name} (${mb(file.size)}, over 5 MB)`);
    } else if (alreadyAttached + added.length >= MAX_IMAGES) {
      tooMany++;
    } else {
      try {
        const data = await readBase64(file);
        added.push({ id: `img-${Date.now()}-${++seq}`, name, media_type: file.type, data });
      } catch {
        refused.push(`${name} (could not be read)`);
      }
    }
  }
  if (tooMany > 0) refused.push(`${tooMany} more (5 per message)`);
  return {
    added,
    error: refused.length > 0 ? `Not attached: ${refused.join(', ')}. ${IMAGE_RULE}` : null,
  };
}

/** Paperclip button that opens the file picker. */
export function AttachButton({
  disabled,
  onFiles,
  className,
  label,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  className?: string;
  /** Shows this text next to the icon (the phone's chat options sheet). Icon only when omitted. */
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // so picking the same file again still fires
    if (files.length > 0) onFiles(files);
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ALLOWED_TYPES.join(',')}
        className="hidden"
        onChange={change}
        tabIndex={-1}
        aria-hidden
      />
      <Button
        type="button"
        variant="outline"
        size={label ? 'default' : 'icon'}
        className={className}
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label={label ? undefined : 'Attach'}
        title="Attach images"
      >
        <PaperclipIcon />
        {label}
      </Button>
    </>
  );
}

/** Thumbnails of the attached images, each with a remove button. */
export function AttachmentStrip({
  items,
  disabled,
  onRemove,
}: {
  items: Attachment[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attached images">
      {items.map((img) => (
        <li key={img.id} className="relative">
          <img
            src={imageSrc(img)}
            alt={img.name}
            className="size-16 rounded-md border object-cover"
          />
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            disabled={disabled}
            onClick={() => onRemove(img.id)}
            aria-label={`Remove ${img.name}`}
            className="absolute -top-1.5 -right-1.5 rounded-full"
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}
