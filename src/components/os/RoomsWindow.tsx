// Rooms window for the OS desktop — the RoomsPanel living inside the
// window system instead of always visible on the desktop body. The panel
// keeps its own zod-validated wiring; this wrapper only supplies window
// chrome, read from the app's manifest so geometry/title live in the
// registry. Stays mounted while minimized so the live poll and list state
// survive a dock restore.
import { RoomsPanel } from "@/components/os/RoomsPanel";
import { WindowFrame } from "@/components/os/Window";
import { appManifest } from "@/components/os/app-manifests";

interface RoomsWindowProps {
  focused: boolean;
  minimized: boolean;
  zIndex: number;
  cascade: number;
  onFocus: () => void;
  onMinimize: () => void;
  onClose: () => void;
}

export function RoomsWindow({
  focused,
  minimized,
  zIndex,
  cascade,
  onFocus,
  onMinimize,
  onClose,
}: RoomsWindowProps) {
  // SAFETY: the shell only mounts windows for ids it read from the same
  // registry; a missing manifest would mean the two lists diverged.
  const manifest = appManifest("rooms")!;
  return (
    <WindowFrame
      title={manifest.title}
      ariaLabel={manifest.ariaLabel}
      focused={focused}
      minimized={minimized}
      zIndex={zIndex}
      cascade={cascade}
      width={manifest.width}
      height={manifest.height}
      onFocus={onFocus}
      onMinimize={onMinimize}
      onClose={onClose}
    >
      <div className="os-window-body os-window-body-rooms">
        <RoomsPanel />
      </div>
    </WindowFrame>
  );
}
