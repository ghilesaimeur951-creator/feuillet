package app.feuillet.scanner;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Locale;

/**
 * Minimal read-only provider for the files the app shares or prints (cache/shared). Avoids an
 * AndroidX dependency; only files inside that directory can be opened.
 */
public final class ShareProvider extends ContentProvider {

    static File sharedDir(Context context) {
        return new File(context.getCacheDir(), "shared");
    }

    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "document";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    static File writeShared(Context context, String name, byte[] data) throws IOException {
        File dir = sharedDir(context);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Cache indisponible");
        // Old shared files are no longer needed.
        File[] old = dir.listFiles();
        long limit = System.currentTimeMillis() - 24L * 3600_000L;
        if (old != null) for (File f : old) if (f.lastModified() < limit) //noinspection ResultOfMethodCallIgnored
            f.delete();
        File f = new File(dir, safeName(name));
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
        return f;
    }

    static Uri uriFor(Context context, String name) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".share").appendPath(safeName(name)).build();
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        Context ctx = getContext();
        String name = uri.getLastPathSegment();
        if (ctx == null || name == null) throw new FileNotFoundException();
        File dir = sharedDir(ctx);
        File f = new File(dir, safeName(name));
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new FileNotFoundException();
        } catch (IOException e) {
            throw new FileNotFoundException();
        }
        if (!f.exists()) throw new FileNotFoundException();
        return f;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Lecture seule");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] cols = projection != null ? projection : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
