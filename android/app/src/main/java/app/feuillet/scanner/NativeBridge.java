package app.feuillet.scanner;

import android.Manifest;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * Exposed to the page as window.FeuilletAndroid (see src/services/native.ts). Called on a
 * background thread by the WebView; UI work is posted to the main thread.
 */
final class NativeBridge {
    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String version() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    /** Saves a file into Downloads/Feuillet. Returns where it went (empty string on failure). */
    @JavascriptInterface
    public String saveFile(String name, String mime, String base64) {
        String safe = ShareProvider.safeName(name);
        byte[] data = Base64.decode(base64, Base64.DEFAULT);
        try {
            String where;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver resolver = activity.getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Feuillet");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("MediaStore insert failed");
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new IOException("No output stream");
                    out.write(data);
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                where = "Téléchargements/Feuillet";
            } else if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Feuillet");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdirs failed");
                File f = uniqueFile(dir, safe);
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(data);
                }
                where = "Téléchargements/Feuillet";
            } else {
                // Android 9 and older without the storage permission: ask for it, and offer the
                // share sheet meanwhile so the export is not lost.
                activity.runOnUiThread(() -> activity.requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, MainActivity.REQ_STORAGE));
                shareBytes(safe, mime, data, safe);
                return "";
            }
            toast("Enregistré dans " + where + " : " + safe);
            return where;
        } catch (IOException | RuntimeException e) {
            toast("Enregistrement impossible : " + e.getMessage());
            return "";
        }
    }

    @JavascriptInterface
    public void shareFile(String name, String mime, String base64, String title) {
        shareBytes(ShareProvider.safeName(name), mime, Base64.decode(base64, Base64.DEFAULT), title);
    }

    @JavascriptInterface
    public void printPdf(String name, String base64) {
        try {
            File f = ShareProvider.writeShared(activity, ShareProvider.safeName(name), Base64.decode(base64, Base64.DEFAULT));
            activity.runOnUiThread(() -> {
                PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                if (pm != null) pm.print(f.getName(), new PdfPrintAdapter(f), new PrintAttributes.Builder().build());
            });
        } catch (IOException e) {
            toast("Impression impossible : " + e.getMessage());
        }
    }

    @JavascriptInterface
    public String takeShared() {
        return activity.takeShared();
    }

    @JavascriptInterface
    public void setSystemBars(String color, boolean dark) {
        activity.runOnUiThread(() -> activity.applySystemBars(color, dark));
    }

    private void shareBytes(String name, String mime, byte[] data, String title) {
        try {
            ShareProvider.writeShared(activity, name, data);
            Uri uri = ShareProvider.uriFor(activity, name);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            send.setClipData(ClipData.newRawUri(name, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, title);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.runOnUiThread(() -> activity.startActivity(chooser));
        } catch (IOException | RuntimeException e) {
            toast("Partage impossible : " + e.getMessage());
        }
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; f.exists() && i < 1000; i++) f = new File(dir, base + " (" + i + ")" + ext);
        return f;
    }

    private void toast(String message) {
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
    }
}
