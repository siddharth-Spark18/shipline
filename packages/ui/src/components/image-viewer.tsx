import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, getCurrentRepo } from '@/lib/api';
import type { ImageData } from '@/lib/types';

const src = (img: ImageData) => `data:${img.media_type};base64,${img.data}`;

/** A full-size image in a dialog. */
export function ImageViewer({ image, onClose }: { image: ImageData | null; onClose: () => void }) {
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] w-auto max-w-[min(95vw,1200px)] place-items-center overflow-auto sm:max-w-[min(95vw,1200px)]">
        <DialogTitle className="sr-only">Image</DialogTitle>
        <DialogDescription className="sr-only">Full-size view of the image.</DialogDescription>
        {image && (
          <img
            src={src(image)}
            alt="Full size"
            className="max-h-[80vh] max-w-full object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One image of a chat, fetched when it is shown (an entry carries a reference, not the data). */
function RefImage({
  chatId,
  imageRef,
  onOpen,
}: {
  chatId: string;
  imageRef: string | null;
  onOpen: (i: ImageData) => void;
}) {
  const q = useQuery({
    queryKey: ['chat-image', getCurrentRepo(), chatId, imageRef],
    queryFn: () => api.chatImage(chatId, imageRef as string),
    enabled: imageRef !== null,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
  if (q.data) {
    const img = q.data;
    return (
      <button
        type="button"
        onClick={() => onOpen(img)}
        className="overflow-hidden rounded-lg border focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Open image full size"
      >
        <img src={src(img)} alt="" className="max-h-32 max-w-48 object-cover" />
      </button>
    );
  }
  const gone = imageRef === null || q.isError;
  return (
    <span className="flex h-16 w-24 items-center justify-center rounded-lg border border-dashed px-2 text-center text-xs text-muted-foreground">
      {gone ? 'Image no longer available' : 'Loading image...'}
    </span>
  );
}

/** Clickable thumbnails of a chat's images by reference; a click opens the image full size. */
export function ChatImages({ chatId, refs }: { chatId: string; refs: (string | null)[] }) {
  const [open, setOpen] = useState<ImageData | null>(null);
  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {refs.map((r, i) => (
          <RefImage key={`${r}:${i}`} chatId={chatId} imageRef={r} onOpen={setOpen} />
        ))}
      </div>
      <ImageViewer image={open} onClose={() => setOpen(null)} />
    </>
  );
}
