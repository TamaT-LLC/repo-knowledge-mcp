import { loadFont } from "@remotion/fonts";
import { cancelRender, staticFile } from "remotion";

void loadFont({
  family: "Noto Sans JP",
  url: staticFile("fonts/NotoSansJP.ttf"),
  weight: "100 900",
}).catch(cancelRender);

void loadFont({
  family: "Space Grotesk",
  url: staticFile("fonts/SpaceGrotesk.ttf"),
  weight: "300 700",
}).catch(cancelRender);

export const sans = '"Space Grotesk", "Noto Sans JP", sans-serif';
export const mono = '"Courier New", "Noto Sans JP", monospace';
