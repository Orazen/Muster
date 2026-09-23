import { Composition, Folder, registerRoot } from "remotion";
import { LaunchFilm } from "./LaunchFilm";

const FPS = 30;
const DURATION = 58 * FPS;

const RemotionRoot = () => (
  <>
    <Folder name="Muster-launch-film">
      <Composition id="MusterLaunch16x9" component={LaunchFilm} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} defaultProps={{ aspect: "landscape" }} />
      <Composition id="MusterLaunch9x16" component={LaunchFilm} durationInFrames={DURATION} fps={FPS} width={1080} height={1920} defaultProps={{ aspect: "portrait" }} />
      <Composition id="MusterLaunch1x1" component={LaunchFilm} durationInFrames={DURATION} fps={FPS} width={1080} height={1080} defaultProps={{ aspect: "square" }} />
    </Folder>
  </>
);

registerRoot(RemotionRoot);
