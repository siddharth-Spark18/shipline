import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
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

/** Clickable thumbnails; a click opens the image full size. */
export function ImageThumbs({ images }: { images: ImageData[] }) {
  const [open, setOpen] = useState<ImageData | null>(null);
  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(img)}
            className="overflow-hidden rounded-lg border focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            aria-label="Open image full size"
          >
            <img src={src(img)} alt="" className="max-h-32 max-w-48 object-cover" />
          </button>
        ))}
      </div>
      <ImageViewer image={open} onClose={() => setOpen(null)} />
    </>
  );
}
