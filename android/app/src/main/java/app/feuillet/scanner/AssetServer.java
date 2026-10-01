package app.feuillet.scanner;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Serves the web application bundled in the APK (assets/www) on a stable HTTPS origin, so that
 * IndexedDB, Web Workers, WebAssembly and getUserMedia behave exactly as on the website.
 * Nothing is fetched from the network: the app has no INTERNET permission.
 *
 * Files shared to the app ("Share to Feuillet") are exposed under /__shared/ID for the page to
 * fetch, without copying them.
 */
final class AssetServer {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("wasm", "application/wasm");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("pfb", "application/octet-stream");
        MIME.put("bcmap", "application/octet-stream");
        MIME.put("traineddata", "application/octet-stream");
        MIME.put("txt", "text/plain");
    }

    private final AssetManager assets;
    private final ContentResolver resolver;
    private final Map<String, Uri> shared = new ConcurrentHashMap<>();

    AssetServer(Context context) {
        this.assets = context.getAssets();
        this.resolver = context.getContentResolver();
    }

    /** Makes a content:// file readable by the page; returns its URL. */
    String registerShared(Uri uri) {
        String id = UUID.randomUUID().toString();
        shared.put(id, uri);
        return ORIGIN + "/__shared/" + id;
    }

    WebResourceResponse serve(Uri url) {
        if (url == null || !HOST.equals(url.getHost()) || !"https".equals(url.getScheme())) return null;
        String path = url.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..") || path.contains("\\")) return error(400, "Bad Request");

        if (path.startsWith("/__shared/")) {
            Uri uri = shared.get(path.substring("/__shared/".length()));
            if (uri == null) return error(404, "Not Found");
            try {
                String type = resolver.getType(uri);
                InputStream in = resolver.openInputStream(uri);
                if (in == null) return error(404, "Not Found");
                return response(type != null ? type : "application/octet-stream", in);
            } catch (IOException | SecurityException e) {
                return error(403, "Forbidden");
            }
        }

        try {
            InputStream in = assets.open("www" + path, AssetManager.ACCESS_STREAMING);
            return response(mimeFor(path), in);
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    static String mimeFor(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String m = MIME.get(ext);
        return m != null ? m : "application/octet-stream";
    }

    private static WebResourceResponse response(String mime, InputStream data) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("X-Content-Type-Options", "nosniff");
        boolean text = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("javascript") || mime.endsWith("+xml");
        return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, data);
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }
}
