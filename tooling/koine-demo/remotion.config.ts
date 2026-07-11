import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// GIF for the README; MP4 for the docs site / social cards.
Config.setConcurrency(4);
