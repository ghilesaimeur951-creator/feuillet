package app.feuillet.scanner;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Feuillet for Android: the web app in a WebView, with camera, file picker, share and print. */
public class MainActivity extends Activity {
    private static final int REQ_FILES = 1;
    private static final int REQ_CAMERA = 2;
    static final int REQ_STORAGE = 3;

    private WebView web;
    private AssetServer server;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private final JSONArray pendingShared = new JSONArray();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        server = new AssetServer(this);
        createWebView();
        applySystemBars(isNight() ? "#10161D" : "#F6F4EF", isNight());

        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) {
            // Restored after the process was killed in the background.
        } else {
            web.loadUrl(AssetServer.ORIGIN + "/index.html");
        }
        handleIntent(getIntent());
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(isNight() ? Color.parseColor("#10161D") : Color.parseColor("#F6F4EF"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " FeuilletAndroid");

        web.addJavascriptInterface(new NativeBridge(this), "FeuilletAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return server.serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (AssetServer.HOST.equals(u.getHost())) return false;
                // External links open in the browser; the app itself never navigates away.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process crashed or was killed to free memory: rebuild the WebView
                // instead of letting the whole app crash. Documents are safe in IndexedDB.
                if (view != web) return true;
                ViewGroup parent = (ViewGroup) view.getParent();
                if (parent != null) parent.removeView(view);
                view.destroy();
                createWebView();
                web.loadUrl(AssetServer.ORIGIN + "/index.html#/");
                android.widget.Toast.makeText(MainActivity.this, "Feuillet a redémarré l’affichage (mémoire insuffisante).", android.widget.Toast.LENGTH_LONG).show();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return openFileChooser(callback, params);
            }
        });
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    // ---------- Camera permission (getUserMedia) ----------

    private void handleWebPermission(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String r : request.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
        if (!wantsCamera) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            if (pendingPermission != null) pendingPermission.deny();
            pendingPermission = request;
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_CAMERA && pendingPermission != null) {
            if (granted) pendingPermission.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else pendingPermission.deny();
            pendingPermission = null;
        }
    }

    // ---------- File picker (<input type="file">) ----------

    private boolean openFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        String[] types = mimeTypes(params.getAcceptTypes());
        if (types.length == 1) intent.setType(types[0]);
        else {
            intent.setType("*/*");
            if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        }
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(intent, REQ_FILES);
            return true;
        } catch (ActivityNotFoundException e) {
            fileCallback = null;
            return false;
        }
    }

    /** Converts an HTML accept list ("image/*,.pdf,.docx") into MIME types for the system picker. */
    static String[] mimeTypes(String[] accept) {
        Set<String> out = new LinkedHashSet<>();
        if (accept != null) {
            for (String group : accept) {
                if (group == null) continue;
                for (String raw : group.split(",")) {
                    String a = raw.trim().toLowerCase(Locale.ROOT);
                    if (a.isEmpty()) continue;
                    if (a.contains("/")) out.add(a);
                    else switch (a) {
                        case ".pdf": out.add("application/pdf"); break;
                        case ".docx": out.add("application/vnd.openxmlformats-officedocument.wordprocessingml.document"); break;
                        case ".xlsx": out.add("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); break;
                        case ".pptx": out.add("application/vnd.openxmlformats-officedocument.presentationml.presentation"); break;
                        case ".doc": out.add("application/msword"); break;
                        case ".xls": out.add("application/vnd.ms-excel"); break;
                        case ".ppt": out.add("application/vnd.ms-powerpoint"); break;
                        case ".txt": out.add("text/plain"); break;
                        case ".zip": out.add("application/zip"); break;
                        case ".png": out.add("image/png"); break;
                        case ".jpg": case ".jpeg": out.add("image/jpeg"); break;
                        default: out.add("*/*");
                    }
                }
            }
        }
        if (out.isEmpty() || out.contains("*/*")) return new String[] {"*/*"};
        return out.toArray(new String[0]);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            result = uris.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---------- Files shared / opened with Feuillet ----------

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        }
        if (uris.isEmpty()) return;
        synchronized (pendingShared) {
            for (Uri u : uris) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("url", server.registerShared(u));
                    o.put("name", displayName(u));
                    String type = getContentResolver().getType(u);
                    o.put("type", type != null ? type : "");
                    pendingShared.put(o);
                } catch (JSONException | SecurityException ignored) {
                }
            }
        }
        // The page picks them up at start-up, or now if it is already running.
        web.evaluateJavascript("window.__feuilletShared && window.__feuilletShared()", null);
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "fichier";
    }

    /** Returns (and forgets) the files shared to the app, as JSON. */
    String takeShared() {
        synchronized (pendingShared) {
            String json = pendingShared.toString();
            while (pendingShared.length() > 0) pendingShared.remove(0);
            return json;
        }
    }

    // ---------- System bars follow the app theme ----------

    void applySystemBars(String color, boolean dark) {
        Window w = getWindow();
        int c;
        try {
            c = Color.parseColor(color);
        } catch (IllegalArgumentException e) {
            return;
        }
        w.setStatusBarColor(c);
        w.setNavigationBarColor(c);
        web.setBackgroundColor(c);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController ctl = w.getInsetsController();
            if (ctl != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ctl.setSystemBarsAppearance(dark ? 0 : light, light);
            }
        } else {
            View decor = w.getDecorView();
            int flags = decor.getSystemUiVisibility();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            decor.setSystemUiVisibility(dark ? (flags & ~light) : (flags | light));
        }
    }

    // ---------- Lifecycle and back button ----------

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Close an open sheet/dialog first, then go back in the app, then leave.
        web.evaluateJavascript(
            "(function(){if(document.querySelector('.sheet-backdrop')){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 'sheet';}"
                + "var h=location.hash;if(h&&h!=='#/'&&h!=='#'){history.back();return 'back';}return 'exit';})()",
            value -> {
                if ("\"exit\"".equals(value)) moveTaskToBack(true);
            });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
