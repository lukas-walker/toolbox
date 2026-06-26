import { loadScript } from "./loadScript.js";

// Same-origin, vendored CV stack. NEVER load these from a CDN — the toolbox is
// an offline-first PWA and these files are precached by the service worker.
const OPENCV_SRC = `${import.meta.env.BASE_URL}vendor/opencv/opencv.js`;
const JSCANIFY_SRC = `${import.meta.env.BASE_URL}vendor/jscanify.js`;

let openCvPromise = null;
let jscanifyPromise = null;

/**
 * Wait until OpenCV.js has finished initializing its (WASM) runtime.
 *
 * OpenCV.js sets the global `cv` synchronously when the script runs, but the
 * runtime (Mat/imread/etc.) only becomes usable asynchronously once the wasm
 * module is compiled. Depending on the build, `cv` is either a thenable that
 * resolves to the ready module, an already-initialized object, or an object
 * that signals readiness via `cv.onRuntimeInitialized`.
 * @returns {Promise<any>} the initialized global `cv`
 */
function whenOpenCvReady() {
    return new Promise((resolve, reject) => {
        const cv = window.cv;
        if (!cv) {
            reject(new Error("OpenCV.js loaded but global `cv` is missing."));
            return;
        }

        // Some builds expose `cv` as a Promise/thenable factory.
        if (typeof cv.then === "function") {
            cv.then((mod) => {
                window.cv = mod;
                resolve(mod);
            }, reject);
            return;
        }

        // Runtime already initialized (e.g. a repeat call).
        if (typeof cv.Mat === "function") {
            resolve(cv);
            return;
        }

        // Wait for the emscripten runtime-ready signal.
        cv.onRuntimeInitialized = () => resolve(window.cv);
    });
}

/**
 * Lazily load OpenCV.js and jscanify and resolve only once OpenCV's runtime is
 * fully initialized and jscanify is available. Idempotent — safe to call from
 * `init()` repeatedly; the underlying scripts are only fetched/initialized once.
 * @returns {Promise<any>} the initialized global `cv`
 */
export function loadOpenCv() {
    if (openCvPromise) return openCvPromise;

    openCvPromise = loadScript(OPENCV_SRC)
        .then(whenOpenCvReady)
        // jscanify depends on a ready `cv`, so it is loaded afterwards.
        .then(async (cv) => {
            await loadJscanify();
            return cv;
        })
        .catch((err) => {
            // Allow a later retry if loading/initialization failed.
            openCvPromise = null;
            throw err;
        });

    return openCvPromise;
}

/**
 * Load jscanify (after OpenCV.js is ready) and resolve with its class.
 * Idempotent.
 * @returns {Promise<Function>} the global `jscanify` class
 */
export function loadJscanify() {
    if (jscanifyPromise) return jscanifyPromise;

    jscanifyPromise = loadScript(OPENCV_SRC)
        .then(whenOpenCvReady)
        .then(() => loadScript(JSCANIFY_SRC))
        .then(() => {
            if (typeof window.jscanify !== "function") {
                throw new Error("jscanify loaded but global `jscanify` is missing.");
            }
            return window.jscanify;
        })
        .catch((err) => {
            jscanifyPromise = null;
            throw err;
        });

    return jscanifyPromise;
}
