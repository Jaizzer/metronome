import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';

export default defineConfig({
	// alphaTab's worker (and audio worklet) become chunks of the build. Its
	// font and soundfont are imported with ?url in src/tabview.js, so the
	// plugin doesn't need to copy them into public/.
	plugins: [alphaTab({ assetOutputDir: false })],
	server: {
		port: 5173,
	},
});
