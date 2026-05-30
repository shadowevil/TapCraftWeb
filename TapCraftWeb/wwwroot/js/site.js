(function bootGameShell() {
	const canvas = document.getElementById("game-canvas");
	if (!canvas) {
		return;
	}

	const context = canvas.getContext("2d", { alpha: false });
	if (!context) {
		return;
	}

	function resizeCanvas() {
		const dpr = window.devicePixelRatio || 1;
		const displayWidth = Math.floor(window.innerWidth * dpr);
		const displayHeight = Math.floor(window.innerHeight * dpr);

		if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
			canvas.width = displayWidth;
			canvas.height = displayHeight;
		}

		context.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function drawPlaceholder() {
		const width = window.innerWidth;
		const height = window.innerHeight;

		context.fillStyle = "#050812";
		context.fillRect(0, 0, width, height);

		context.fillStyle = "#c7e3ff";
		context.font = "600 20px Segoe UI, sans-serif";
		context.textAlign = "center";
		context.fillText("TapCraft canvas ready", width / 2, height / 2 - 12);

		context.fillStyle = "#88a8d8";
		context.font = "400 14px Segoe UI, sans-serif";
		context.fillText("Hook your engine in window.tapCraft.start()", width / 2, height / 2 + 18);
	}

	async function tryBootWasmModule() {
		const wasmEntryPath = canvas.dataset.wasmEntry;
		if (!wasmEntryPath) {
			return;
		}

		try {
			const wasmModule = await import(wasmEntryPath);
			if (typeof wasmModule.start === "function") {
				await wasmModule.start(canvas);
			}
		} catch (error) {
			console.error("Failed to load WebAssembly entry module.", error);
		}
	}

	window.addEventListener("resize", () => {
		resizeCanvas();
		drawPlaceholder();
	});

	resizeCanvas();
	drawPlaceholder();

	if (window.tapCraft && typeof window.tapCraft.start === "function") {
		window.tapCraft.start(canvas, context);
	} else {
		void tryBootWasmModule();
	}
})();
