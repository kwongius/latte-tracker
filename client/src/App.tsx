import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64, SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Latte = ApiResponse<typeof api, "listLattes">["lattes"][number];
type RatingValue = 1 | 2 | 3 | 4 | 5 | null;
type PhotoDraft = { file: File; preview: string };

function localDateTimeValue(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function isoToLocalInput(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? localDateTimeValue() : localDateTimeValue(date);
}

// Phone photos arrive in whatever format the camera used (HEIC on iPhone,
// huge multi-megabyte JPEGs elsewhere) and browsers report their MIME types
// inconsistently, so checking file.type up front silently drops valid
// photos. Instead, decode whatever was picked and re-encode it as a
// reasonably sized JPEG: that normalizes the format the server stores and
// keeps an 8-photo upload small enough to save reliably.
async function normalizePhoto(file: File): Promise<File | null> {
  const maxDimension = 2048;
  let bitmap: ImageBitmap | null = null;
  let image: HTMLImageElement | null = null;
  let objectUrl: string | null = null;
  try {
    let width: number;
    let height: number;
    let source: CanvasImageSource;
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(file);
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } else {
      objectUrl = URL.createObjectURL(file);
      image = new Image();
      const loaded = image;
      const url = objectUrl;
      await new Promise<void>((resolve, reject) => {
        loaded.onload = () => resolve();
        loaded.onerror = () => reject(new Error("decode failed"));
        loaded.src = url;
      });
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    }
    if (width === 0 || height === 0) return null;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return null;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "latte-photo";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  } finally {
    bitmap?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (image) image.src = "";
  }
}

function Icon({ name }: { name: "camera" | "image" | "close" | "pin" | "milk" | "cup" | "trash" | "edit" }) {
  const paths: Record<typeof name, ReactNode> = {
    camera: <><path d="M4 7h3l1.2-2h7.6L17 7h3v11H4z"/><circle cx="12" cy="12.5" r="3.2"/></>,
    image: <><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5 3 3L16 12l3 3.5"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    pin: <><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></>,
    milk: <><path d="M8 3h8l1 4v14H7V7z"/><path d="M8 7h9M10 3v4"/></>,
    cup: <><path d="M5 8h12v6a6 6 0 0 1-12 0zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M7 4c0 1 1 1 1 2M12 3c0 1 1 1 1 2"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
    edit: <><path d="M17 3.5 20.5 7 9 18.5H5.5V15Z"/><path d="m14.5 6 3.5 3.5"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Rating({ label, hint, value, onChange }: { label: string; hint: string; value: RatingValue; onChange: (value: RatingValue) => void }) {
  return (
    <fieldset className="rating-field">
      <div className="rating-copy">
        <legend>{label}</legend>
        <span>{hint}</span>
      </div>
      <div className="rating-scale" aria-label={`${label} rating`}>
        {([1, 2, 3, 4, 5] as const).map((score) => (
          <button
            type="button"
            key={score}
            className={value === score ? "selected" : ""}
            aria-label={`${label}: ${score} out of 5`}
            aria-pressed={value === score}
            onClick={() => onChange(value === score ? null : score)}
          >
            {score}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function scoreForLatte(latte: Latte): number | null {
  const values = [latte.espressoQuality, latte.overallQuality, latte.milkQuality].filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function artTone(value: number) {
  return value >= 6.5 ? "great" : value >= 5 ? "good" : value >= 4 ? "mid" : "low";
}

// Art score: one decimal on a 0–10 scale, colour-coded —
// strong pours green, mid pours amber, rough pours red.
// Collapsed rows keep it terse: the score chip plus a bare win–loss line
// only (no W/L suffixes, no matchup count). The matchup count shows
// only when the entry is expanded (see ArtHero).
function ArtScore({ value, wins, losses, comparisons }: { value: number; wins: number; losses: number; comparisons: number }) {
  return (
    <span className="art-score-wrap">
      <span className={`art-score ${artTone(value)}`} aria-label={`Latte art score ${value.toFixed(1)} out of 10, ${wins} wins and ${losses} losses in ${comparisons} matchups`}>
        {value.toFixed(1)}
      </span>
      <small>{wins}–{losses}</small>
    </span>
  );
}

// Expanded entries get the art record front and centre: an oversized
// score chip with the win/loss record set large beside it.
function ArtHero({ value, wins, losses, comparisons }: { value: number; wins: number; losses: number; comparisons: number }) {
  return (
    <div className="art-hero">
      <span className={`art-score big ${artTone(value)}`}>{value.toFixed(1)}</span>
      <div className="art-hero-copy">
        <span className="art-hero-label">Art score · out of 10</span>
        <strong>{wins} {wins === 1 ? "win" : "wins"} · {losses} {losses === 1 ? "loss" : "losses"}</strong>
        <small>{comparisons} {comparisons === 1 ? "matchup" : "matchups"} played</small>
      </div>
    </div>
  );
}

// Full-screen photo viewer. On phones it takes the whole screen and
// supports pinch-to-zoom plus drag-to-pan (and double-tap to toggle
// zoom); on desktop it opens as a large centred popup with wheel zoom
// and on-screen controls. Esc, the close button, or a tap on the dimmed
// backdrop all close it; arrow keys move between photos.
function PhotoViewer({ photos, startIndex, onClose }: { photos: { id: number; url: string }[]; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(startIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; center: { x: number; y: number } } | null>(null);

  const applyView = (nextScale: number, nextOffset: { x: number; y: number }) => {
    const clampedScale = Math.min(4, Math.max(1, nextScale));
    // Keep the panned image from drifting completely out of reach.
    const bound = 260 * clampedScale;
    const clampedOffset = clampedScale <= 1
      ? { x: 0, y: 0 }
      : {
          x: Math.min(bound, Math.max(-bound, nextOffset.x)),
          y: Math.min(bound, Math.max(-bound, nextOffset.y)),
        };
    scaleRef.current = clampedScale;
    offsetRef.current = clampedOffset;
    setScale(clampedScale);
    setOffset(clampedOffset);
  };

  const goTo = (step: number) => {
    setIndex((current) => {
      const next = current + step;
      return next < 0 || next >= photos.length ? current : next;
    });
    applyView(1, { x: 0, y: 0 });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") goTo(1);
      if (event.key === "ArrowLeft") goTo(-1);
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
    // goTo is stable enough for this listener's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, photos.length]);

  const photo = photos[index];
  if (!photo) return null;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinchRef.current = null;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointersRef.current.get(event.pointerId);
    if (!previous) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];
    if (points.length === 1) {
      if (scaleRef.current > 1) {
        applyView(scaleRef.current, {
          x: offsetRef.current.x + (event.clientX - previous.x),
          y: offsetRef.current.y + (event.clientY - previous.y),
        });
      }
    } else if (points.length === 2) {
      const [first, second] = points as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const last = pinchRef.current;
      if (last && last.distance > 0) {
        applyView(scaleRef.current * (distance / last.distance), {
          x: offsetRef.current.x + (center.x - last.center.x),
          y: offsetRef.current.y + (center.y - last.center.y),
        });
      }
      pinchRef.current = { distance, center };
    }
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  return (
    <div
      className="photo-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="photo-viewer-frame">
        <div
          className="photo-viewer-stage"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onWheel={(event) => applyView(scaleRef.current * (event.deltaY < 0 ? 1.15 : 0.87), offsetRef.current)}
          onDoubleClick={() => applyView(scaleRef.current > 1 ? 1 : 2.5, { x: 0, y: 0 })}
        >
          <img
            src={photo.url}
            alt={`Latte photo ${index + 1} of ${photos.length}, full screen`}
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          />
        </div>
        <button type="button" className="photo-viewer-close" aria-label="Close photo viewer" onClick={onClose}>
          <Icon name="close" />
        </button>
        <div className="photo-viewer-bar">
          <span className="photo-viewer-count">{index + 1} / {photos.length}</span>
          <div className="photo-viewer-controls">
            <button type="button" aria-label="Previous photo" disabled={index === 0} onClick={() => goTo(-1)}>‹</button>
            <button type="button" aria-label="Zoom out" disabled={scale <= 1} onClick={() => applyView(scaleRef.current / 1.4, offsetRef.current)}>−</button>
            <button type="button" aria-label="Zoom in" disabled={scale >= 4} onClick={() => applyView(scaleRef.current * 1.4, offsetRef.current)}>+</button>
            <button type="button" aria-label="Reset zoom" disabled={scale === 1} onClick={() => applyView(1, { x: 0, y: 0 })}>Reset</button>
            <button type="button" aria-label="Next photo" disabled={index >= photos.length - 1} onClick={() => goTo(1)}>›</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  return {
    date: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date),
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date),
  };
}

export function App() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const milkTouched = useRef(false);
  const [madeAt, setMadeAt] = useState(localDateTimeValue());
  const [location, setLocation] = useState("");
  const [milk, setMilk] = useState("");
  const [espressoQuality, setEspressoQuality] = useState<RatingValue>(null);
  const [overallQuality, setOverallQuality] = useState<RatingValue>(null);
  const [milkQuality, setMilkQuality] = useState<RatingValue>(null);
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [rankedExpandedId, setRankedExpandedId] = useState<number | null>(null);
  const [deleteCandidateId, setDeleteCandidateId] = useState<number | null>(null);
  // Head-to-head art ranking session: a focused placement run for one pour
  // (focusId set) or an open calibration run across the journal (null).
  const [session, setSession] = useState<{ focusId: number | null; remaining: number } | null>(null);
  const [matchupIds, setMatchupIds] = useState<{ aId: number; bId: number } | null>(null);
  const [matchupError, setMatchupError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  // Full-screen viewer: which pour's photos, and which photo to open on.
  const [viewer, setViewer] = useState<{ photos: Latte["photos"]; index: number } | null>(null);
  // Inline editing: one entry at a time, shared by the rankings list and
  // the journal since both render the same expanded detail.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editMadeAt, setEditMadeAt] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editMilk, setEditMilk] = useState("");
  const [editEspressoQuality, setEditEspressoQuality] = useState<RatingValue>(null);
  const [editOverallQuality, setEditOverallQuality] = useState<RatingValue>(null);
  const [editMilkQuality, setEditMilkQuality] = useState<RatingValue>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editExistingPhotos, setEditExistingPhotos] = useState<{ id: number; url: string }[]>([]);
  const [editNewPhotos, setEditNewPhotos] = useState<PhotoDraft[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSavedNotice, setEditSavedNotice] = useState(false);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const editCameraInputRef = useRef<HTMLInputElement>(null);
  const matchupRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<{ focusId: number | null; remaining: number } | null>(null);

  const lattesQuery = useQuery({
    queryKey: ["lattes"],
    queryFn: () => api.listLattes({ limit: 100 }),
  });

  useEffect(() => {
    if (!milkTouched.current && lattesQuery.data?.lastMilk) {
      setMilk(lattesQuery.data.lastMilk);
    }
  }, [lattesQuery.data?.lastMilk]);

  const addLatte = useMutation({
    mutationFn: async () => {
      // Drafts were normalized to JPEG when picked, so encoding here can
      // never fail on a format the browser happened to report.
      const encodedPhotos = [];
      for (const draft of photos) {
        const encoded = await fileToBase64(draft.file);
        encodedPhotos.push({ dataBase64: encoded.dataBase64, mimeType: "image/jpeg" as const, name: draft.file.name });
      }
      return api.addLatte({
        madeAt: new Date(madeAt).toISOString(),
        location: location.trim() || null,
        milk: milk.trim() || null,
        espressoQuality,
        overallQuality,
        milkQuality,
        notes: notes.trim() || null,
        photos: encodedPhotos,
      });
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        setFormError(result.error ?? "That latte wasn’t saved.");
        return;
      }
      const hadPhotos = photos.length > 0;
      const otherPhotoPours = (lattesQuery.data?.lattes ?? []).filter((latte) => latte.photos.length > 0).length;
      photos.forEach((photo) => URL.revokeObjectURL(photo.preview));
      setPhotos([]);
      setEspressoQuality(null);
      setOverallQuality(null);
      setMilkQuality(null);
      setNotes("");
      setMadeAt(localDateTimeValue());
      setFormError(null);
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2800);
      await queryClient.invalidateQueries({ queryKey: ["lattes"] });
      // Placement: a new pour with a photo immediately faces a
      // few similarly scored pours so it lands in the rankings.
      if (result.id && hadPhotos && otherPhotoPours > 0) {
        startSession(result.id, Math.min(5, otherPhotoPours));
      }
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : "That latte wasn’t saved."),
  });

  const deleteLatte = useMutation({
    mutationFn: (id: number) => api.deleteLatte({ id }),
    onSuccess: async (result, id) => {
      if (!result.ok) {
        setFormError(result.error ?? "That entry couldn’t be deleted.");
        return;
      }
      setDeleteCandidateId(null);
      setExpandedId((current) => (current === id ? null : current));
      setRankedExpandedId((current) => (current === id ? null : current));
      await queryClient.invalidateQueries({ queryKey: ["lattes"] });
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : "That entry couldn’t be deleted."),
  });

  const updateLatte = useMutation({
    mutationFn: (args: Parameters<typeof api.updateLatte>[0]) => api.updateLatte(args),
    onSuccess: async (result) => {
      if (!result.ok) {
        setEditError(result.error ?? "Those changes weren’t saved.");
        return;
      }
      editNewPhotos.forEach((photo) => URL.revokeObjectURL(photo.preview));
      setEditNewPhotos([]);
      setEditingId(null);
      setEditError(null);
      setEditSavedNotice(true);
      window.setTimeout(() => setEditSavedNotice(false), 2800);
      await queryClient.invalidateQueries({ queryKey: ["lattes"] });
    },
    onError: (error) => setEditError(error instanceof Error ? error.message : "Those changes weren’t saved."),
  });

  const suggestMatchup = useMutation({
    mutationFn: (focusId: number | null) => api.suggestMatchup({ focusId }),
  });

  const recordComparison = useMutation({
    mutationFn: (args: { winnerId: number; loserId: number }) => api.recordComparison(args),
    onSuccess: async (result, args) => {
      if (!result.ok) {
        setMatchupError(result.error ?? "That pick wasn’t saved.");
        return;
      }
      setMatchupError(null);
      const all = lattesQuery.data?.lattes ?? [];
      const winner = all.find((latte) => latte.id === args.winnerId);
      const loser = all.find((latte) => latte.id === args.loserId);
      if (winner && loser && result.winnerArtScore !== undefined && result.loserArtScore !== undefined) {
        setLastResult(
          `${formatWhen(winner.madeAt).date} pour up to ${result.winnerArtScore.toFixed(1)} · ${formatWhen(loser.madeAt).date} pour at ${result.loserArtScore.toFixed(1)}`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["lattes"] });
      const current = sessionRef.current;
      if (!current) return;
      if (current.remaining > 1) {
        const next = { ...current, remaining: current.remaining - 1 };
        sessionRef.current = next;
        setSession(next);
        void fetchMatchup(current.focusId);
      } else {
        sessionRef.current = null;
        setSession(null);
        setMatchupIds(null);
      }
    },
    onError: (error) => setMatchupError(error instanceof Error ? error.message : "That pick wasn’t saved."),
  });

  const resetRankings = useMutation({
    mutationFn: () => api.resetArtRankings({}),
    onSuccess: async (result) => {
      if (!result.ok) {
        setMatchupError(result.error ?? "The scores couldn’t be reset.");
        return;
      }
      setResetArmed(false);
      sessionRef.current = null;
      setSession(null);
      setMatchupIds(null);
      setLastResult("Scores reset to the 5.0 baseline — run matchups to rerank from scratch.");
      await queryClient.invalidateQueries({ queryKey: ["lattes"] });
    },
  });

  async function fetchMatchup(focusId: number | null) {
    try {
      const result = await suggestMatchup.mutateAsync(focusId);
      if (!result.ok || result.aId === undefined || result.bId === undefined) {
        setMatchupError(result.error ?? "No matchup available right now.");
        setMatchupIds(null);
        sessionRef.current = null;
        setSession(null);
        return;
      }
      setMatchupError(null);
      setMatchupIds({ aId: result.aId, bId: result.bId });
    } catch {
      setMatchupError("No matchup available right now.");
      setMatchupIds(null);
      sessionRef.current = null;
      setSession(null);
    }
  }

  function startSession(focusId: number | null, rounds: number) {
    setLastResult(null);
    setMatchupError(null);
    const next = { focusId, remaining: rounds };
    sessionRef.current = next;
    setSession(next);
    void fetchMatchup(focusId);
    window.setTimeout(() => matchupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }

  function endSession() {
    sessionRef.current = null;
    setSession(null);
    setMatchupIds(null);
    setMatchupError(null);
  }

  function pickWinner(winnerId: number, loserId: number) {
    if (recordComparison.isPending) return;
    recordComparison.mutate({ winnerId, loserId });
  }

  function startEdit(latte: Latte) {
    setDeleteCandidateId(null);
    setEditError(null);
    setEditSavedNotice(false);
    setEditingId(latte.id);
    setEditMadeAt(isoToLocalInput(latte.madeAt));
    setEditLocation(latte.location ?? "");
    setEditMilk(latte.milk ?? "");
    setEditEspressoQuality((latte.espressoQuality as RatingValue) ?? null);
    setEditOverallQuality((latte.overallQuality as RatingValue) ?? null);
    setEditMilkQuality((latte.milkQuality as RatingValue) ?? null);
    setEditNotes(latte.notes ?? "");
    setEditExistingPhotos(latte.photos.map((photo) => ({ id: photo.id, url: photo.url })));
    editNewPhotos.forEach((photo) => URL.revokeObjectURL(photo.preview));
    setEditNewPhotos([]);
  }

  function cancelEdit() {
    editNewPhotos.forEach((photo) => URL.revokeObjectURL(photo.preview));
    setEditNewPhotos([]);
    setEditingId(null);
    setEditError(null);
  }

  async function handleEditPhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    const room = Math.max(0, 8 - editExistingPhotos.length - editNewPhotos.length);
    if (room === 0) {
      setEditError("You can keep up to 8 photos per latte.");
      return;
    }
    const candidates = selected.slice(0, room);
    const added: PhotoDraft[] = [];
    let unreadable = 0;
    for (const file of candidates) {
      const normalized = await normalizePhoto(file);
      if (normalized) {
        added.push({ file: normalized, preview: URL.createObjectURL(normalized) });
      } else {
        unreadable += 1;
      }
    }
    if (added.length > 0) {
      setEditNewPhotos((current) => [...current, ...added].slice(0, 8));
      setEditError(null);
    }
    if (unreadable > 0) {
      setEditError(
        unreadable === candidates.length
          ? "That photo couldn’t be read. Try another one from your library."
          : "Some photos couldn’t be read and were skipped.",
      );
    } else if (selected.length > room) {
      setEditError("Only 8 photos fit per latte — the rest were left out.");
    }
  }

  function moveEditExisting(index: number, delta: number) {
    setEditExistingPhotos((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      if (!item) return current;
      copy.splice(target, 0, item);
      return copy;
    });
  }

  function moveEditNew(index: number, delta: number) {
    setEditNewPhotos((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      if (!item) return current;
      copy.splice(target, 0, item);
      return copy;
    });
  }

  function removeEditNew(index: number) {
    setEditNewPhotos((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((_, photoIndex) => photoIndex !== index);
    });
  }

  async function saveEdit() {
    if (editingId === null || updateLatte.isPending) return;
    setEditError(null);
    if (!editMadeAt || Number.isNaN(new Date(editMadeAt).getTime())) {
      setEditError("Choose a valid date and time.");
      return;
    }
    const encodedPhotos = [];
    for (const draft of editNewPhotos) {
      const encoded = await fileToBase64(draft.file);
      encodedPhotos.push({ dataBase64: encoded.dataBase64, mimeType: "image/jpeg" as const, name: draft.file.name });
    }
    updateLatte.mutate({
      id: editingId,
      madeAt: new Date(editMadeAt).toISOString(),
      location: editLocation.trim() || null,
      milk: editMilk.trim() || null,
      espressoQuality: editEspressoQuality,
      overallQuality: editOverallQuality,
      milkQuality: editMilkQuality,
      notes: editNotes.trim() || null,
      keepPhotoIds: editExistingPhotos.map((photo) => photo.id),
      newPhotos: encodedPhotos,
    });
  }

  // Shared expanded detail for one pour, used identically by the ranked
  // list (the primary record) and the chronological journal, so expanding
  // or deleting works the same way from either list.
  function renderEntryDetail(latte: Latte, photoPourCount: number) {
    if (editingId === latte.id) {
      const editTotalPhotos = editExistingPhotos.length + editNewPhotos.length;
      return (
        <div className="entry-detail">
          <form
            className="edit-form"
            aria-label={`Edit latte from ${formatWhen(latte.madeAt).date}`}
            onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}
          >
            <div className="edit-form-heading">
              <strong>Edit this pour</strong>
              <span>Art score stays as earned — it isn’t edited here.</span>
            </div>
            <ArtHero value={latte.artScore} wins={latte.artWins} losses={latte.artLosses} comparisons={latte.artComparisons} />

            <div className="edit-photo-section">
              <span className="edit-label">Photos <small>{editTotalPhotos} of 8 — tap × to remove, arrows to reorder</small></span>
              {editTotalPhotos === 0 && <p className="edit-photo-empty">No photos on this pour. Add one below to make it rankable.</p>}
              {editExistingPhotos.length > 0 && (
                <div className="edit-photo-strip">
                  {editExistingPhotos.map((photo, index) => (
                    <div className="edit-photo" key={photo.id}>
                      <img src={photo.url} alt={`Existing latte photo ${index + 1}`} />
                      <button type="button" className="edit-photo-remove" aria-label={`Remove existing photo ${index + 1}`} onClick={() => setEditExistingPhotos((current) => current.filter((item) => item.id !== photo.id))}><Icon name="close" /></button>
                      <div className="edit-photo-move">
                        <button type="button" aria-label={`Move existing photo ${index + 1} earlier`} disabled={index === 0} onClick={() => moveEditExisting(index, -1)}>‹</button>
                        <button type="button" aria-label={`Move existing photo ${index + 1} later`} disabled={index === editExistingPhotos.length - 1} onClick={() => moveEditExisting(index, 1)}>›</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {editNewPhotos.length > 0 && (
                <div className="edit-photo-strip">
                  {editNewPhotos.map((photo, index) => (
                    <div className="edit-photo" key={`${photo.file.name}-${photo.preview}`}>
                      <img src={photo.preview} alt={`New latte photo ${index + 1}`} />
                      <span className="edit-photo-badge">New</span>
                      <button type="button" className="edit-photo-remove" aria-label={`Remove new photo ${index + 1}`} onClick={() => removeEditNew(index)}><Icon name="close" /></button>
                      <div className="edit-photo-move">
                        <button type="button" aria-label={`Move new photo ${index + 1} earlier`} disabled={index === 0} onClick={() => moveEditNew(index, -1)}>‹</button>
                        <button type="button" aria-label={`Move new photo ${index + 1} later`} disabled={index === editNewPhotos.length - 1} onClick={() => moveEditNew(index, 1)}>›</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {editTotalPhotos < 8 && (
                <div className="edit-photo-add">
                  <button className="add-photo edit-add-photo" type="button" onClick={() => editCameraInputRef.current?.click()}>
                    <Icon name="camera" />
                    <span>Take photo</span>
                  </button>
                  <button className="add-photo edit-add-photo" type="button" onClick={() => editFileInputRef.current?.click()}>
                    <Icon name="image" />
                    <span>Add photos</span>
                  </button>
                  <input ref={editCameraInputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" aria-label="Take a latte photo for this entry" onChange={handleEditPhotos} />
                  <input ref={editFileInputRef} className="visually-hidden" type="file" accept="image/*" multiple aria-label="Choose latte photos for this entry" onChange={handleEditPhotos} />
                </div>
              )}
            </div>

            <div className="when-row edit-when">
              <label htmlFor={`edit-made-at-${latte.id}`}>Made at</label>
              <input id={`edit-made-at-${latte.id}`} type="datetime-local" value={editMadeAt} onChange={(event) => setEditMadeAt(event.target.value)} required />
            </div>

            <div className="detail-grid edit-detail-grid">
              <label className="input-field" htmlFor={`edit-location-${latte.id}`}>
                <span><Icon name="pin" /> Location <small>optional</small></span>
                <input id={`edit-location-${latte.id}`} list="previous-locations" value={editLocation} onChange={(event) => setEditLocation(event.target.value)} placeholder="Where did you make it?" />
              </label>
              <label className="input-field" htmlFor={`edit-milk-${latte.id}`}>
                <span><Icon name="milk" /> Milk <small>optional</small></span>
                <input id={`edit-milk-${latte.id}`} list="milk-options" value={editMilk} onChange={(event) => setEditMilk(event.target.value)} placeholder="None or type your milk" />
              </label>
            </div>

            <div className="edit-ratings">
              <Rating label="Espresso" hint="taste & extraction" value={editEspressoQuality} onChange={setEditEspressoQuality} />
              <Rating label="Milk quality" hint="how well the milk was steamed" value={editMilkQuality} onChange={setEditMilkQuality} />
              <Rating label="Overall" hint="the whole cup" value={editOverallQuality} onChange={setEditOverallQuality} />
            </div>

            <label className="notes-field" htmlFor={`edit-notes-${latte.id}`}>
              <span>Notes <small>optional</small></span>
              <textarea id={`edit-notes-${latte.id}`} value={editNotes} onChange={(event) => setEditNotes(event.target.value)} placeholder="Grind, timing, what to try next…" rows={3} />
            </label>

            {editError && <p className="form-message error" role="alert">{editError}</p>}
            <div className="edit-actions">
              <button className="save-button edit-save" type="submit" disabled={updateLatte.isPending}>{updateLatte.isPending ? "Saving…" : "Save changes"}</button>
              <button className="edit-cancel" type="button" disabled={updateLatte.isPending} onClick={cancelEdit}>Cancel</button>
            </div>
          </form>
        </div>
      );
    }

    return (
      <div className="entry-detail">
        {editSavedNotice && editingId === null && <p className="form-message success" role="status">Changes saved.</p>}
        {latte.photos.length > 0 && (
          <div className="saved-photos">
            {latte.photos.map((photo, photoIndex) => (
              <button
                key={photo.id}
                type="button"
                className="saved-photo"
                aria-label={`View latte photo ${photoIndex + 1} full screen`}
                onClick={() => setViewer({ photos: latte.photos, index: photoIndex })}
              >
                <img src={photo.url} alt={`Latte photo ${photoIndex + 1}`} />
              </button>
            ))}
          </div>
        )}
        <ArtHero value={latte.artScore} wins={latte.artWins} losses={latte.artLosses} comparisons={latte.artComparisons} />
        <dl>
          <div><dt>Espresso</dt><dd>{latte.espressoQuality ?? "—"}</dd></div>
          <div><dt>Milk quality</dt><dd>{latte.milkQuality ?? "—"}</dd></div>
          <div><dt>Overall</dt><dd>{latte.overallQuality ?? "—"}</dd></div>
        </dl>
        {(latte.location || latte.milk) && (
          <p className="entry-meta-line">
            {latte.location ? <span>{latte.location}</span> : null}
            {latte.location && latte.milk ? <span aria-hidden="true"> · </span> : null}
            {latte.milk ? <span>{latte.milk}</span> : null}
          </p>
        )}
        {latte.notes && <p className="entry-notes">{latte.notes}</p>}
        <div className="entry-actions">
          <button className="edit-button" type="button" onClick={() => startEdit(latte)}><Icon name="edit" /> Edit entry</button>
          {latte.photos.length > 0 && photoPourCount >= 2 && (
            <button className="rank-button entry-rank-button" type="button" disabled={session !== null} onClick={() => startSession(latte.id, Math.min(5, photoPourCount - 1))}>
              {session ? "Ranking in progress above" : "Rerank this pour"}
            </button>
          )}
        </div>
        {deleteCandidateId === latte.id ? (
          <div className="delete-confirm">
            <span>Delete this entry?</span>
            <button type="button" onClick={() => setDeleteCandidateId(null)}>Keep it</button>
            <button className="danger" type="button" disabled={deleteLatte.isPending} onClick={() => deleteLatte.mutate(latte.id)}>Delete</button>
          </div>
        ) : (
          <button className="delete-button" type="button" onClick={() => setDeleteCandidateId(latte.id)}><Icon name="trash" /> Delete entry</button>
        )}
      </div>
    );
  }

  const scored = useMemo(() => (lattesQuery.data?.lattes ?? []).map((latte) => ({ latte, score: scoreForLatte(latte) })).filter((item): item is { latte: Latte; score: number } => item.score !== null), [lattesQuery.data?.lattes]);
  const trend = useMemo(() => {
    if (scored.length < 4) return null;
    const recent = scored.slice(0, Math.min(5, Math.ceil(scored.length / 2)));
    const prior = scored.slice(recent.length, recent.length * 2);
    if (prior.length === 0) return null;
    const recentAvg = recent.reduce((sum, item) => sum + item.score, 0) / recent.length;
    const priorAvg = prior.reduce((sum, item) => sum + item.score, 0) / prior.length;
    return { recentAvg, delta: recentAvg - priorAvg, count: recent.length };
  }, [scored]);

  async function handlePhotos(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    // Reset immediately so picking the same photo again still fires a change.
    event.target.value = "";
    if (selected.length === 0) return;
    const room = Math.max(0, 8 - photos.length);
    if (room === 0) {
      setFormError("You can add up to 8 photos per latte.");
      return;
    }
    const candidates = selected.slice(0, room);
    const added: PhotoDraft[] = [];
    let unreadable = 0;
    for (const file of candidates) {
      const normalized = await normalizePhoto(file);
      if (normalized) {
        added.push({ file: normalized, preview: URL.createObjectURL(normalized) });
      } else {
        unreadable += 1;
      }
    }
    if (added.length > 0) {
      setPhotos((current) => [...current, ...added].slice(0, 8));
      setFormError(null);
    }
    if (unreadable > 0) {
      setFormError(
        unreadable === candidates.length
          ? "That photo couldn’t be read. Try another one from your library."
          : "Some photos couldn’t be read and were skipped.",
      );
    } else if (selected.length > room) {
      setFormError("Only 8 photos fit per latte — the rest were left out.");
    }
  }

  function removePhoto(index: number) {
    setPhotos((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((_, photoIndex) => photoIndex !== index);
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setSavedNotice(false);
    setFormError(null);
    if (!madeAt || Number.isNaN(new Date(madeAt).getTime())) {
      setFormError("Choose a valid date and time.");
      return;
    }
    addLatte.mutate();
  }

  const lattes = lattesQuery.data?.lattes ?? [];
  const average = scored.length > 0 ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : null;
  const ranked = useMemo(
    () =>
      lattes
        .filter((latte) => latte.photos.length > 0)
        .sort((a, b) => b.artScore - a.artScore || b.artComparisons - a.artComparisons || b.madeAt.localeCompare(a.madeAt)),
    [lattes],
  );
  const unrankable = useMemo(() => lattes.filter((latte) => latte.photos.length === 0), [lattes]);
  const photoPourCount = lattes.filter((latte) => latte.photos.length > 0).length;
  const matchupA = matchupIds ? lattes.find((latte) => latte.id === matchupIds.aId) ?? null : null;
  const matchupB = matchupIds ? lattes.find((latte) => latte.id === matchupIds.bId) ?? null : null;

  if (lattesQuery.data?.ownerRequired) {
    return (
      <div className="app-shell">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main>
          <section className="morning-intro">
            <h1>Owner sign-in needed.</h1>
            <p>This latte journal is private. Sign in as the owner to see your pours, photos, and art rankings.</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main>
        <div className="entry-layout">
          <div className="entry-column">
        <section className="morning-intro">
          <h1>Make this cup count.</h1>
        </section>
        <form className="composer" onSubmit={submit}>
          <div className="photo-strip">
            {photos.map((photo, index) => (
              <div className="photo-draft" key={`${photo.file.name}-${photo.preview}`}>
                <img src={photo.preview} alt={`Selected latte photo ${index + 1}`} />
                <button type="button" aria-label={`Remove photo ${index + 1}`} onClick={() => removePhoto(index)}><Icon name="close" /></button>
              </div>
            ))}
            {photos.length < 8 && (
              <>
                <button className="add-photo" type="button" onClick={() => cameraInputRef.current?.click()}>
                  <Icon name="camera" />
                  <span>Take photo</span>
                </button>
                <button className="add-photo" type="button" onClick={() => fileInputRef.current?.click()}>
                  <Icon name="image" />
                  <span>{photos.length === 0 ? "Add photos" : "Add more"}</span>
                </button>
              </>
            )}
            <input ref={cameraInputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" aria-label="Take a latte photo" onChange={handlePhotos} />
            <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*" multiple aria-label="Choose latte photos" onChange={handlePhotos} />
          </div>

          <div className="when-row">
            <label htmlFor="made-at">Made at</label>
            <input id="made-at" type="datetime-local" value={madeAt} onChange={(event) => setMadeAt(event.target.value)} required />
          </div>

          <div className="detail-grid">
            <label className="input-field" htmlFor="location">
              <span><Icon name="pin" /> Location <small>optional</small></span>
              <input id="location" list="previous-locations" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Where did you make it?" />
            </label>
            <datalist id="previous-locations">
              {(lattesQuery.data?.previousLocations ?? []).map((item) => <option key={item} value={item} />)}
            </datalist>

            <label className="input-field" htmlFor="milk">
              <span><Icon name="milk" /> Milk <small>optional</small></span>
              <input id="milk" list="milk-options" value={milk} onChange={(event) => { milkTouched.current = true; setMilk(event.target.value); }} placeholder="None or type your milk" />
            </label>
            <datalist id="milk-options">
              {["Whole milk", "2% milk", "Nonfat milk", "Oat milk", "Almond milk", "Soy milk"].map((item) => <option key={item} value={item} />)}
            </datalist>
          </div>

          <section className="outcome-section">
            <div className="section-heading">
              <div><span>How did it turn out?</span><small>Everything here is optional</small></div>
              <Icon name="cup" />
            </div>
            <Rating label="Espresso" hint="taste & extraction" value={espressoQuality} onChange={setEspressoQuality} />
            <Rating label="Milk quality" hint="how well the milk was steamed" value={milkQuality} onChange={setMilkQuality} />
            <Rating label="Overall" hint="the whole cup" value={overallQuality} onChange={setOverallQuality} />
            <label className="notes-field" htmlFor="notes">
              <span>Notes <small>optional</small></span>
              <textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Grind, timing, what to try next…" rows={3} />
            </label>
          </section>

          {formError && <p className="form-message error" role="alert">{formError}</p>}
          {savedNotice && <p className="form-message success" role="status">Latte logged. Nice pour.</p>}
          <button className="save-button" type="submit" disabled={addLatte.isPending}>{addLatte.isPending ? "Saving…" : "Log this latte"}</button>
        </form>

        {session && (
          <section className="matchup-section" aria-labelledby="matchup-heading" ref={matchupRef}>
            <div className="journal-heading">
              <div>
                <p>{session.focusId !== null ? "Place this pour" : "Rerank mode"}</p>
                <h2 id="matchup-heading">Which art is better?</h2>
              </div>
              <span>{session.remaining} {session.remaining === 1 ? "matchup" : "matchups"} left</span>
            </div>
            <p className="matchup-hint">Tap the pour with the better latte art — art only, not taste. Scores update after every pick, and each new pour faces pours scored close to it.</p>
            {matchupError && <p className="form-message error" role="alert">{matchupError}</p>}
            {matchupA && matchupB ? (
              <div className="matchup-arena">
                {([matchupA, matchupB] as const).map((contender, index) => {
                  const other = index === 0 ? matchupB : matchupA;
                  const when = formatWhen(contender.madeAt);
                  return (
                    <button
                      key={contender.id}
                      type="button"
                      className="matchup-card"
                      disabled={recordComparison.isPending}
                      aria-label={`Pick the ${when.date} pour as the better latte art`}
                      onClick={() => pickWinner(contender.id, other.id)}
                    >
                      <img src={contender.photos[0]?.url} alt={`Latte art from ${when.date}`} />
                      <span className="matchup-meta">
                        <strong>{when.date}</strong>
                        <small>{when.time}{contender.location ? ` · ${contender.location}` : ""}</small>
                        <small>{contender.artWins}W · {contender.artLosses}L · {contender.artComparisons} {contender.artComparisons === 1 ? "match" : "matches"}</small>
                      </span>
                      <span className="matchup-pick">This one’s better</span>
                    </button>
                  );
                })}
                <span className="matchup-vs" aria-hidden="true">vs</span>
              </div>
            ) : (
              !matchupError && <p className="loading-copy">Finding a matchup…</p>
            )}
            {lastResult && <p className="form-message success" role="status">{lastResult}</p>}
            <div className="matchup-actions">
              <button type="button" onClick={() => void fetchMatchup(session.focusId)}>Skip this pair</button>
              <button type="button" onClick={endSession}>Done ranking</button>
            </div>
          </section>
        )}
          </div>

          <div className="progress-column">
        <section className="progress-section" aria-labelledby="progress-heading">
          <div className="journal-heading">
            <div><p>Practice, in view</p><h2 id="progress-heading">Your progress</h2></div>
            <span>{lattes.length} {lattes.length === 1 ? "cup" : "cups"}</span>
          </div>
          <p className="progress-intro">
            Your latte-art journey so far — every pour you’ve logged, ranked head-to-head, art against art.
            {lattes.length > 0 && (
              <> You’ve made {lattes.length} {lattes.length === 1 ? "pour" : "pours"} so far{(lattesQuery.data?.totalComparisons ?? 0) > 0 && ranked[0] ? <>, played {(lattesQuery.data?.totalComparisons ?? 0)} {(lattesQuery.data?.totalComparisons ?? 0) === 1 ? "matchup" : "matchups"}, and your best art sits at {ranked[0].artScore.toFixed(1)}</> : ""}.</>
            )}
          </p>
          {lattes.length === 0 ? (
            <div className="empty-state"><span>01</span><h3>Your first cup starts the line.</h3><p>Log a latte above; patterns will appear as you build your practice.</p></div>
          ) : (
            <div className="progress-band">
              <div className="progress-number"><strong>{average === null ? "—" : average.toFixed(1)}</strong><span>average quality<br />across rated cups</span></div>
              <div className="progress-direction">
                <span>Direction</span>
                {trend ? <><strong className={trend.delta >= 0 ? "positive" : "negative"}>{trend.delta >= 0 ? "+" : ""}{trend.delta.toFixed(1)}</strong><small>recent {trend.count} vs. prior {trend.count}</small></> : <><strong>Building baseline</strong><small>Rate at least 4 cups to compare.</small></>}
              </div>
            </div>
          )}
        </section>
          </div>
        </div>

        <section className="rankings-section" aria-labelledby="rankings-heading">
          <div className="journal-heading">
            <div><p>Latte art, ranked</p><h2 id="rankings-heading">Art rankings</h2></div>
            <span>{ranked.length} {ranked.length === 1 ? "pour" : "pours"} ranked</span>
          </div>
          <p className="rankings-intro">Your primary record, ordered by art score from 0 to 10. Tap any pour to expand it — photos, ratings, notes, and delete work here exactly as they do in the journal below. Pours without a photo can’t be art-ranked, but they’re listed underneath, expandable the same way.</p>
          {lastResult && !session && <p className="form-message success" role="status">{lastResult}</p>}
          {matchupError && !session && <p className="form-message error" role="alert">{matchupError}</p>}
          {lattesQuery.isPending && <p className="loading-copy">Opening your rankings…</p>}
          {ranked.length === 0 && unrankable.length === 0 ? (
            <div className="empty-state"><span>10</span><h3>No pours to rank yet.</h3><p>Log a latte with a photo and it will appear here, ready for matchups.</p></div>
          ) : (
            <>
              {ranked.length > 0 && (
                <div className="journal-list">
                  {ranked.map((latte, index) => {
                    const when = formatWhen(latte.madeAt);
                    const expanded = rankedExpandedId === latte.id;
                    return (
                      <article className="journal-entry" key={latte.id}>
                        <button className="entry-summary" type="button" aria-expanded={expanded} onClick={() => setRankedExpandedId(expanded ? null : latte.id)}>
                          <div className="ranked-position">{index + 1}</div>
                          <img className="entry-thumb" src={latte.photos[0]?.url} alt="Latte preview" />
                          <div className="entry-main"><strong>{when.date}</strong><span>{when.time}{latte.location ? ` · ${latte.location}` : ""}</span><small>{latte.milk ?? "Milk not recorded"}</small></div>
                          <ArtScore value={latte.artScore} wins={latte.artWins} losses={latte.artLosses} comparisons={latte.artComparisons} />
                        </button>
                        {expanded && renderEntryDetail(latte, photoPourCount)}
                      </article>
                    );
                  })}
                </div>
              )}
              {unrankable.length > 0 && (
                <>
                  <h3 className="unranked-heading">Not ranked — no photo to judge</h3>
                  <div className="journal-list">
                    {unrankable.map((latte) => {
                      const when = formatWhen(latte.madeAt);
                      const expanded = rankedExpandedId === latte.id;
                      return (
                        <article className="journal-entry" key={latte.id}>
                          <button className="entry-summary" type="button" aria-expanded={expanded} onClick={() => setRankedExpandedId(expanded ? null : latte.id)}>
                            <div className="ranked-position">—</div>
                            <div className="entry-thumb placeholder"><Icon name="cup" /></div>
                            <div className="entry-main"><strong>{when.date}</strong><span>{when.time}{latte.location ? ` · ${latte.location}` : ""}</span><small>{latte.milk ?? "Milk not recorded"}</small></div>
                            <ArtScore value={latte.artScore} wins={latte.artWins} losses={latte.artLosses} comparisons={latte.artComparisons} />
                          </button>
                          {expanded && renderEntryDetail(latte, photoPourCount)}
                        </article>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
          <div className="rankings-actions">
            <button type="button" className="rank-start" disabled={photoPourCount < 2 || session !== null} onClick={() => startSession(null, 10)}>
              {session ? "Ranking in progress above" : photoPourCount < 2 ? "Rank pours (needs 2+ photos)" : "Rerank pours"}
            </button>
            {resetArmed ? (
              <span className="reset-confirm">
                Reset all art scores to their seeds?
                <button type="button" className="danger" disabled={resetRankings.isPending} onClick={() => resetRankings.mutate()}>Yes, reset</button>
                <button type="button" onClick={() => setResetArmed(false)}>Keep scores</button>
              </span>
            ) : (
              <button type="button" className="rank-reset" onClick={() => setResetArmed(true)}>Reset scores</button>
            )}
          </div>
        </section>

        <section className="journal-section" aria-labelledby="journal-heading">
          <div className="journal-heading"><div><p>History, by date</p><h2 id="journal-heading">Latte journal</h2></div></div>
          {lattesQuery.isPending && <p className="loading-copy">Opening your journal…</p>}
          {lattesQuery.isError && <div className="query-error" role="alert"><p>Couldn’t open the journal.</p><button type="button" onClick={() => lattesQuery.refetch()}>Try again</button></div>}
          <div className="journal-list">
            {lattes.map((latte, index) => {
              const when = formatWhen(latte.madeAt);
              const expanded = expandedId === latte.id;
              return (
                <article className="journal-entry" key={latte.id}>
                  <button className="entry-summary" type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : latte.id)}>
                    <div className="entry-index">{String(lattes.length - index).padStart(2, "0")}</div>
                    {latte.photos[0] ? <img className="entry-thumb" src={latte.photos[0].url} alt="Latte preview" /> : <div className="entry-thumb placeholder"><Icon name="cup" /></div>}
                    <div className="entry-main"><strong>{when.date}</strong><span>{when.time}{latte.location ? ` · ${latte.location}` : ""}</span><small>{latte.milk ?? "Milk not recorded"}</small></div>
                    <ArtScore value={latte.artScore} wins={latte.artWins} losses={latte.artLosses} comparisons={latte.artComparisons} />
                  </button>
                  {expanded && renderEntryDetail(latte, photoPourCount)}
                </article>
              );
            })}
          </div>
        </section>
      </main>
      {viewer && <PhotoViewer photos={viewer.photos} startIndex={viewer.index} onClose={() => setViewer(null)} />}
    </div>
  );
}
