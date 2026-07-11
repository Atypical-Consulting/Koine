import React from "react";
import { Composition } from "remotion";
import { KoineDemo } from "./KoineDemo";

// 14.4 seconds at 30fps. Kept short and loopable for a README GIF.
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="KoineDemo"
      component={KoineDemo}
      durationInFrames={432}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
