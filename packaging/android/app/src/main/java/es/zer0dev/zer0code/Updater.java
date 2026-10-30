package es.zer0dev.zer0code;

import android.app.Activity;
import android.app.Dialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Html;
import android.text.SpannableStringBuilder;
import android.text.TextUtils;
import android.text.method.LinkMovementMethod;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Actualizaciones de la app: mira el último release de GitHub y, si es más nuevo que esta versión, ofrece
 * actualizar. El APK se descarga dentro de la app (con barra de progreso), se comprueba contra el
 * SHA256SUMS.txt del release y se instala con PackageInstaller, que devuelve el motivo si algo falla (por
 * ejemplo, una app instalada con otra firma). Al volver a abrir la app se comprueba si la actualización se
 * aplicó: si sí, se enseñan las novedades; si no, se explica por qué en vez de volver a ofrecer lo mismo.
 */
final class Updater {
    private static final String REPO_API = "https://api.github.com/repos/Zer0Dev-exe/Zer0Code";
    private static final String RELEASES_PAGE = "https://github.com/Zer0Dev-exe/Zer0Code/releases";
    private static final String PREFS = "zer0code";
    private static final String KEY_SKIPPED = "update_skipped";
    private static final String KEY_CHECKED_AT = "update_checked_at";
    private static final String KEY_PENDING = "update_pending";
    private static final String KEY_LAST_ERROR = "update_last_error";
    private static final String KEY_SEEN = "update_seen_version";
    private static final long CHECK_EVERY_MS = 6L * 60 * 60 * 1000;
    private static final String ACTION_INSTALL_RESULT = BuildConfig.APPLICATION_ID + ".INSTALL_RESULT";

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Hoja visible (aviso o novedades): no se abre otra encima */
    private static WeakReference<Sheet> current = new WeakReference<>(null);
    /** APK descargado a la espera de que se conceda el permiso de instalar (y su hoja, aunque se haya ocultado) */
    private static File pendingFile;
    private static Sheet pendingSheet;
    private static String pendingVersion;
    private static boolean busy;

    private Updater() {}

    /** Datos de un release */
    private static final class Release {
        String version;
        String notes;
        String page;
        String date;
        String apkName;
        String apkUrl;
        long apkSize;
        String sumsUrl;
        boolean prerelease;
    }

    /** '1.3.10' -> {1,3,10}; null si no es una versión */
    static int[] parse(String v) {
        if (v == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^v?(\\d+)\\.(\\d+)\\.(\\d+)").matcher(v.trim());
        if (!m.find()) return null;
        return new int[] { Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)) };
    }

    /** Positivo si a es más nueva que b */
    static int compare(String a, String b) {
        int[] x = parse(a);
        int[] y = parse(b);
        if (x == null || y == null) return 0;
        for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] - y[i];
        return 0;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean alive(Activity activity) {
        return activity != null && !activity.isFinishing() && !activity.isDestroyed();
    }

    // ------------------------------------------------------------------------
    // Arranque: ¿se aplicó la última actualización?
    // ------------------------------------------------------------------------

    /**
     * Al abrir la app. Si se acaba de actualizar, enseña las novedades; si se intentó actualizar y sigue la
     * versión anterior, lo explica. Devuelve true si ha abierto alguna hoja.
     */
    static boolean onAppStart(Activity activity) {
        SharedPreferences p = prefs(activity);
        String pending = p.getString(KEY_PENDING, "");
        String seen = p.getString(KEY_SEEN, "");
        String lastError = p.getString(KEY_LAST_ERROR, "");
        p.edit().remove(KEY_PENDING).remove(KEY_LAST_ERROR).putString(KEY_SEEN, BuildConfig.VERSION_NAME).apply();

        if (!pending.isEmpty() && compare(BuildConfig.VERSION_NAME, pending) < 0) {
            showFailed(activity, pending, lastError);
            return true;
        }
        // Actualizada (desde la app o instalando el APK a mano): las novedades una vez por versión
        if (!seen.isEmpty() && compare(BuildConfig.VERSION_NAME, seen) > 0) {
            showWhatsNew(activity, "Zer0Code se ha actualizado a la versión " + BuildConfig.VERSION_NAME);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------------
    // Comprobar
    // ------------------------------------------------------------------------

    /**
     * Comprueba si hay versión nueva. Al abrir la app se hace como mucho cada 6 horas y sin molestar si no hay nada;
     * con manual=true se responde siempre.
     */
    static void check(final Activity activity, final boolean manual) {
        final SharedPreferences p = prefs(activity);
        if (!manual && System.currentTimeMillis() - p.getLong(KEY_CHECKED_AT, 0) < CHECK_EVERY_MS) return;
        if (!manual && current.get() != null) return;

        IO.execute(() -> {
            try {
                final Release found = fetchLatest();
                p.edit().putLong(KEY_CHECKED_AT, System.currentTimeMillis()).apply();
                final boolean newer = found != null && compare(found.version, BuildConfig.VERSION_NAME) > 0;
                final boolean skipped = found != null && found.version.equals(p.getString(KEY_SKIPPED, ""));
                MAIN.post(() -> {
                    if (!alive(activity)) return;
                    // Una comprobación automática no tapa otra hoja (por ejemplo, las novedades tras actualizar)
                    if (newer && !manual && current.get() != null) return;
                    if (newer && (manual || !skipped)) offer(activity, found);
                    else if (manual) Toast.makeText(activity, "Zer0Code " + BuildConfig.VERSION_NAME + " es la última versión", Toast.LENGTH_LONG).show();
                });
            } catch (final Exception e) {
                if (manual) MAIN.post(() -> Toast.makeText(activity, "No se pudo comprobar las actualizaciones", Toast.LENGTH_LONG).show());
            }
        });
    }

    private static String fetchText(String url, int limit) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "Zer0Code-Android/" + BuildConfig.VERSION_NAME);
            int code = connection.getResponseCode();
            if (code != 200) throw new java.io.IOException("GitHub respondió " + code);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) > 0 && out.size() < limit) out.write(buffer, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private static Release toRelease(JSONObject json) throws Exception {
        Release release = new Release();
        release.version = json.optString("tag_name", "").replaceFirst("^[vV]", "");
        release.notes = json.optString("body", "");
        release.page = json.optString("html_url", RELEASES_PAGE);
        release.date = json.optString("published_at", "");
        release.prerelease = json.optBoolean("prerelease", false);
        JSONArray assets = json.optJSONArray("assets");
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                String name = asset.optString("name", "");
                if (name.toLowerCase(Locale.ROOT).endsWith(".apk") && release.apkUrl == null) {
                    release.apkName = name;
                    release.apkUrl = asset.optString("browser_download_url", "");
                    release.apkSize = asset.optLong("size", 0);
                } else if (name.equals("SHA256SUMS.txt")) {
                    release.sumsUrl = asset.optString("browser_download_url", "");
                }
            }
        }
        return release;
    }

    private static Release fetchLatest() throws Exception {
        Release release = toRelease(new JSONObject(fetchText(REPO_API + "/releases/latest", 512 * 1024)));
        // CI sube el APK y las sumas unos minutos después de publicar el release: hasta entonces no se ofrece nada
        if (release.apkUrl == null || release.apkUrl.isEmpty() || release.sumsUrl == null) return null;
        return parse(release.version) == null ? null : release;
    }

    private static List<Release> fetchReleases() throws Exception {
        JSONArray list = new JSONArray(fetchText(REPO_API + "/releases?per_page=12", 2 * 1024 * 1024));
        List<Release> out = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject json = list.getJSONObject(i);
            if (json.optBoolean("draft", false)) continue;
            Release release = toRelease(json);
            if (parse(release.version) != null) out.add(release);
        }
        out.sort((a, b) -> compare(b.version, a.version));
        return out;
    }

    // ------------------------------------------------------------------------
    // Hojas: aviso de versión nueva, novedades y actualización fallida
    // ------------------------------------------------------------------------

    /** Hoja inferior con la estética de la pantalla de conexión */
    private static final class Sheet {
        final Activity activity;
        final Dialog dialog;
        final LinearLayout body;
        final ProgressBar bar;
        final TextView status;
        final Button primary;
        final Button secondary;
        final TextView link;

        Sheet(Activity activity, String title, String subtitle) {
            this.activity = activity;
            dialog = new Dialog(activity);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

            LinearLayout card = new LinearLayout(activity);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(activity, 22), dp(activity, 10), dp(activity, 22), dp(activity, 18));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(activity.getColor(R.color.card));
            float r = dp(activity, 28);
            bg.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
            bg.setStroke(dp(activity, 1), activity.getColor(R.color.border));
            card.setBackground(bg);

            // Asa de la hoja
            View handle = new View(activity);
            handle.setBackground(rounded(activity, R.color.border, dp(activity, 3), false));
            LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(dp(activity, 40), dp(activity, 5));
            hp.gravity = Gravity.CENTER_HORIZONTAL;
            hp.bottomMargin = dp(activity, 16);
            card.addView(handle, hp);

            // Cabecera: logo, título y subtítulo
            LinearLayout head = new LinearLayout(activity);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            TextView logo = text(activity, "Z0", 17, R.color.bg);
            logo.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            logo.setGravity(Gravity.CENTER);
            logo.setBackground(rounded(activity, R.color.text, dp(activity, 12), false));
            head.addView(logo, new LinearLayout.LayoutParams(dp(activity, 44), dp(activity, 44)));
            LinearLayout titles = new LinearLayout(activity);
            titles.setOrientation(LinearLayout.VERTICAL);
            TextView t = text(activity, title, 19, R.color.text);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            titles.addView(t);
            TextView s = text(activity, subtitle, 13, R.color.muted);
            titles.addView(s);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
            tp.leftMargin = dp(activity, 14);
            head.addView(titles, tp);
            card.addView(head);

            // Contenido desplazable (no más de ~55 % de la pantalla)
            body = new LinearLayout(activity);
            body.setOrientation(LinearLayout.VERTICAL);
            final int maxHeight = (int) (activity.getResources().getDisplayMetrics().heightPixels * 0.55f);
            ScrollView scroll = new ScrollView(activity) {
                @Override
                protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                    super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxHeight, View.MeasureSpec.AT_MOST));
                }
            };
            scroll.setVerticalScrollBarEnabled(false);
            scroll.addView(body);
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            sp.topMargin = dp(activity, 16);
            card.addView(scroll, sp);

            // Progreso de la descarga
            bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
            bar.setMax(100);
            bar.setProgressTintList(android.content.res.ColorStateList.valueOf(activity.getColor(R.color.text)));
            bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(activity.getColor(R.color.border)));
            bar.setVisibility(View.GONE);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 6));
            bp.topMargin = dp(activity, 16);
            card.addView(bar, bp);

            status = text(activity, "", 13, R.color.muted);
            status.setVisibility(View.GONE);
            LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            stp.topMargin = dp(activity, 8);
            card.addView(status, stp);

            primary = button(activity, true);
            card.addView(primary, buttonParams(activity, 18));
            secondary = button(activity, false);
            card.addView(secondary, buttonParams(activity, 8));

            link = text(activity, "", 13, R.color.muted);
            link.setGravity(Gravity.CENTER);
            link.setPadding(0, dp(activity, 12), 0, dp(activity, 2));
            link.setVisibility(View.GONE);
            card.addView(link, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            // Android 15 dibuja de borde a borde: hueco para la barra de navegación
            final int basePadding = dp(activity, 18);
            card.setOnApplyWindowInsetsListener((v, insets) -> {
                int bottom = Build.VERSION.SDK_INT >= 30
                        ? insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                        : insets.getSystemWindowInsetBottom();
                v.setPadding(v.getPaddingLeft(), v.getPaddingTop(), v.getPaddingRight(), basePadding + bottom);
                return insets;
            });

            dialog.setContentView(card);
            Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                window.setGravity(Gravity.BOTTOM);
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                window.setWindowAnimations(android.R.style.Animation_InputMethod);
                window.setDimAmount(0.5f);
            }
            dialog.setOnDismissListener(d -> {
                if (current.get() == this) current = new WeakReference<>(null);
            });
        }

        void show() {
            if (!alive(activity)) return;
            current = new WeakReference<>(this);
            dialog.show();
        }

        void dismiss() {
            if (dialog.isShowing() && alive(activity)) dialog.dismiss();
        }

        void setStatus(String message, boolean error) {
            status.setText(message);
            status.setTextColor(activity.getColor(error ? R.color.error : R.color.muted));
            status.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
        }

        void setProgress(int percent) {
            bar.setVisibility(View.VISIBLE);
            bar.setIndeterminate(percent < 0);
            if (percent >= 0) bar.setProgress(percent);
        }
    }

    /** Fila «1.5.2 → 1.5.3» */
    private static View versionRow(Activity a, String from, String to) {
        LinearLayout row = new LinearLayout(a);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(chip(a, "v" + from, false));
        TextView arrow = text(a, "→", 16, R.color.muted);
        arrow.setPadding(dp(a, 10), 0, dp(a, 10), 0);
        row.addView(arrow);
        row.addView(chip(a, "v" + to, true));
        return row;
    }

    private static TextView chip(Activity a, String label, boolean strong) {
        TextView chip = text(a, label, 13, strong ? R.color.accent_text : R.color.text);
        chip.setTypeface(Typeface.MONOSPACE, strong ? Typeface.BOLD : Typeface.NORMAL);
        chip.setPadding(dp(a, 12), dp(a, 5), dp(a, 12), dp(a, 5));
        chip.setBackground(rounded(a, strong ? R.color.accent : R.color.field, dp(a, 999), !strong));
        return chip;
    }

    private static TextView notesView(Activity a, String notes) {
        TextView view = text(a, "", 14, R.color.text);
        view.setText(formatNotes(notes));
        view.setLineSpacing(0, 1.3f);
        view.setLinkTextColor(a.getColor(R.color.text));
        view.setMovementMethod(LinkMovementMethod.getInstance());
        return view;
    }

    private static TextView sectionLabel(Activity a, String label, int topMargin) {
        TextView view = text(a, label.toUpperCase(Locale.ROOT), 11, R.color.muted);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = topMargin;
        lp.bottomMargin = dp(a, 6);
        view.setLayoutParams(lp);
        return view;
    }

    /** Versión nueva disponible */
    private static void offer(final Activity activity, final Release release) {
        Sheet open = current.get();
        if (open != null && open.dialog.isShowing()) open.dismiss();

        final Sheet sheet = new Sheet(activity, "Nueva versión disponible", "Publicada " + formatDate(release.date));
        sheet.body.addView(versionRow(activity, BuildConfig.VERSION_NAME, release.version));
        String notes = release.notes == null ? "" : release.notes.trim();
        if (!notes.isEmpty()) {
            sheet.body.addView(sectionLabel(activity, "Novedades", dp(activity, 18)));
            sheet.body.addView(notesView(activity, notes));
        }

        sheet.primary.setText(release.apkSize > 0 ? "Actualizar ahora · " + (release.apkSize / (1024 * 1024)) + " MB" : "Actualizar ahora");
        sheet.primary.setOnClickListener(v -> download(sheet, release));
        sheet.secondary.setText("Más tarde");
        sheet.secondary.setOnClickListener(v -> sheet.dismiss());
        sheet.link.setText("Omitir esta versión");
        sheet.link.setVisibility(View.VISIBLE);
        sheet.link.setOnClickListener(v -> {
            prefs(activity).edit().putString(KEY_SKIPPED, release.version).apply();
            sheet.dismiss();
        });
        sheet.show();
    }

    /** Novedades: versión instalada, si hay una nueva y las notas de los últimos releases */
    static void showWhatsNew(final Activity activity, final String headline) {
        if (!alive(activity)) return;
        Sheet open = current.get();
        if (open != null && open.dialog.isShowing()) open.dismiss();

        final Sheet sheet = new Sheet(activity, "Novedades", "Tienes la versión " + BuildConfig.VERSION_NAME);
        if (headline != null) {
            TextView banner = text(activity, "✓  " + headline, 14, R.color.text);
            banner.setTypeface(Typeface.DEFAULT_BOLD);
            banner.setPadding(dp(activity, 14), dp(activity, 12), dp(activity, 14), dp(activity, 12));
            banner.setBackground(rounded(activity, R.color.field, dp(activity, 14), true));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(activity, 8);
            sheet.body.addView(banner, lp);
        }
        final TextView loading = text(activity, "Cargando novedades…", 14, R.color.muted);
        sheet.body.addView(loading);
        sheet.primary.setText("Buscar actualizaciones");
        sheet.primary.setOnClickListener(v -> {
            sheet.dismiss();
            check(activity, true);
        });
        sheet.secondary.setText("Cerrar");
        sheet.secondary.setOnClickListener(v -> sheet.dismiss());
        sheet.link.setText("Ver todas las versiones en GitHub");
        sheet.link.setVisibility(View.VISIBLE);
        sheet.link.setOnClickListener(v -> openPage(activity, RELEASES_PAGE));
        sheet.show();

        IO.execute(() -> {
            List<Release> releases = null;
            String error = null;
            try {
                releases = fetchReleases();
            } catch (Exception e) {
                error = e.getMessage();
            }
            final List<Release> list = releases;
            final String failure = error;
            MAIN.post(() -> {
                if (!alive(activity) || !sheet.dialog.isShowing()) return;
                if (list == null) {
                    loading.setText("No se pudieron cargar las novedades" + (failure == null ? "" : " (" + failure + ")"));
                    return;
                }
                sheet.body.removeView(loading);
                Release newest = null;
                for (Release r : list) {
                    if (newest == null && !r.prerelease && r.apkUrl != null && r.sumsUrl != null) newest = r;
                }
                for (int i = 0; i < list.size(); i++) addReleaseBlock(activity, sheet.body, list.get(i), i == 0);
                // Si ya hay una versión más nueva, el botón principal es actualizar
                final Release target = newest;
                if (target != null && compare(target.version, BuildConfig.VERSION_NAME) > 0) {
                    sheet.primary.setText("Actualizar a la v" + target.version);
                    sheet.primary.setOnClickListener(v -> download(sheet, target));
                }
            });
        });
    }

    private static void addReleaseBlock(Activity a, LinearLayout body, Release r, boolean first) {
        LinearLayout head = new LinearLayout(a);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView version = text(a, "v" + r.version, 15, R.color.text);
        version.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        head.addView(version);
        int cmp = compare(r.version, BuildConfig.VERSION_NAME);
        String badge = cmp == 0 ? "Instalada" : cmp > 0 ? "Nueva" : r.prerelease ? "Prueba" : null;
        if (badge != null) {
            TextView b = text(a, badge, 11, cmp > 0 ? R.color.accent_text : R.color.text);
            b.setTypeface(Typeface.DEFAULT_BOLD);
            b.setPadding(dp(a, 8), dp(a, 2), dp(a, 8), dp(a, 2));
            b.setBackground(rounded(a, cmp > 0 ? R.color.accent : R.color.field, dp(a, 999), cmp <= 0));
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            bp.leftMargin = dp(a, 8);
            head.addView(b, bp);
        }
        View spacer = new View(a);
        head.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1));
        head.addView(text(a, formatDate(r.date), 12, R.color.muted));
        if (!first) {
            // Separador fino entre versiones
            View line = new View(a);
            line.setBackgroundColor(a.getColor(R.color.border));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(a, 1));
            lp.topMargin = dp(a, 18);
            body.addView(line, lp);
        }
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.topMargin = first ? dp(a, 4) : dp(a, 14);
        body.addView(head, hp);

        String notes = r.notes == null ? "" : r.notes.trim();
        TextView view = notesView(a, notes.isEmpty() ? "Sin notas." : notes);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        np.topMargin = dp(a, 6);
        body.addView(view, np);
    }

    /** La actualización se instaló pero sigue la versión anterior (o el instalador falló) */
    private static void showFailed(final Activity activity, String version, String reason) {
        final Sheet sheet = new Sheet(activity, "La actualización no se completó", "Sigues con la versión " + BuildConfig.VERSION_NAME);
        String message = "No se llegó a instalar la versión " + version + ".";
        message += "\n\n" + (reason == null || reason.isEmpty()
                ? "Puede que el instalador de Android se cerrara antes de terminar. Vuelve a intentarlo y pulsa «Actualizar» en la ventana del sistema."
                : reason);
        TextView text = text(activity, message, 14, R.color.text);
        text.setLineSpacing(0, 1.3f);
        sheet.body.addView(text);
        sheet.primary.setText("Reintentar");
        sheet.primary.setOnClickListener(v -> {
            sheet.dismiss();
            check(activity, true);
        });
        sheet.secondary.setText("Descargar desde GitHub");
        sheet.secondary.setOnClickListener(v -> openPage(activity, RELEASES_PAGE + "/latest"));
        sheet.link.setText("Cerrar");
        sheet.link.setVisibility(View.VISIBLE);
        sheet.link.setOnClickListener(v -> sheet.dismiss());
        sheet.show();
    }

    // ------------------------------------------------------------------------
    // Descarga, verificación e instalación
    // ------------------------------------------------------------------------

    private static void download(final Sheet sheet, final Release release) {
        if (busy) return;
        busy = true;
        final Activity activity = sheet.activity;
        final Context app = activity.getApplicationContext();
        sheet.primary.setEnabled(false);
        sheet.primary.setAlpha(0.5f);
        sheet.primary.setText("Descargando…");
        sheet.link.setVisibility(View.GONE);
        sheet.secondary.setText("Seguir en segundo plano");
        sheet.setProgress(-1);
        sheet.setStatus("Conectando con GitHub…", false);
        sheet.dialog.setCancelable(false);

        IO.execute(() -> {
            try {
                File dir = new File(app.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("No se pudo preparar la carpeta de descargas");
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
                    f.delete();

                String expected = expectedHash(release.sumsUrl, release.apkName);
                if (expected == null) throw new java.io.IOException("El release no incluye la suma de comprobación del APK");

                File file = new File(dir, "zer0code-" + release.version + ".apk");
                String got = downloadTo(release.apkUrl, file, release.apkSize, sheet);
                if (!expected.equalsIgnoreCase(got)) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                    throw new java.io.IOException("La descarga no coincide con la suma de comprobación: se ha descartado");
                }
                MAIN.post(() -> {
                    busy = false;
                    sheet.setProgress(100);
                    sheet.setStatus("Descarga verificada. Abriendo el instalador…", false);
                    install(sheet, file, release.version);
                });
            } catch (final Exception e) {
                MAIN.post(() -> {
                    busy = false;
                    failed(sheet, "No se pudo descargar: " + e.getMessage());
                });
            }
        });
    }

    private static String expectedHash(String sumsUrl, String apkName) throws Exception {
        if (sumsUrl == null || sumsUrl.isEmpty()) return null;
        for (String line : fetchText(sumsUrl, 64 * 1024).split("\n")) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^([a-fA-F0-9]{64})\\s+\\*?(.+)$").matcher(line.trim());
            if (m.find() && m.group(2).trim().equals(apkName)) return m.group(1);
        }
        return null;
    }

    private static String downloadTo(String url, File file, long size, final Sheet sheet) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Zer0Code-Android/" + BuildConfig.VERSION_NAME);
            int code = connection.getResponseCode();
            if (code != 200) throw new java.io.IOException("GitHub respondió " + code);
            final long total = size > 0 ? size : connection.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long received = 0;
            long lastPost = 0;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[65536];
                int n;
                while ((n = in.read(buffer)) > 0) {
                    out.write(buffer, 0, n);
                    digest.update(buffer, 0, n);
                    received += n;
                    long now = System.currentTimeMillis();
                    if (now - lastPost > 150) {
                        lastPost = now;
                        final long done = received;
                        MAIN.post(() -> {
                            if (total > 0) {
                                int pct = (int) Math.min(99, done * 100 / total);
                                sheet.setProgress(pct);
                                sheet.setStatus(pct + " %  ·  " + mb(done) + " de " + mb(total), false);
                            } else {
                                sheet.setStatus(mb(done) + " descargados", false);
                            }
                        });
                    }
                }
            }
            if (total > 0 && received != total) throw new java.io.IOException("la descarga se cortó");
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } finally {
            connection.disconnect();
        }
    }

    private static void failed(Sheet sheet, String message) {
        prefs(sheet.activity).edit().remove(KEY_PENDING).putString(KEY_LAST_ERROR, message).apply();
        if (!alive(sheet.activity)) return;
        sheet.dialog.setCancelable(true);
        sheet.bar.setVisibility(View.GONE);
        sheet.setStatus(message, true);
        sheet.primary.setEnabled(true);
        sheet.primary.setAlpha(1f);
        sheet.primary.setText("Reintentar");
        sheet.primary.setOnClickListener(v -> {
            sheet.dismiss();
            check(sheet.activity, true);
        });
        sheet.secondary.setText("Descargar desde GitHub");
        sheet.secondary.setOnClickListener(v -> openPage(sheet.activity, RELEASES_PAGE + "/latest"));
    }

    /** Instalar el APK descargado (pide antes el permiso de «instalar apps desconocidas» si falta) */
    private static void install(Sheet sheet, File file, String version) {
        Activity activity = sheet.activity;
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            pendingFile = file;
            pendingSheet = sheet;
            pendingVersion = version;
            sheet.setStatus("Permite «Instalar apps desconocidas» para Zer0Code y vuelve a la app: la instalación seguirá sola.", false);
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
            try {
                activity.startActivity(settings);
            } catch (Exception e) {
                failed(sheet, "Activa «Instalar apps desconocidas» para Zer0Code en los ajustes de Android y vuelve a intentarlo.");
            }
            return;
        }
        pendingFile = null;
        pendingSheet = null;
        pendingVersion = null;
        commitInstall(sheet, file, version);
    }

    /** Al volver a la app tras conceder el permiso de instalar: seguir con la instalación pendiente */
    static void onResume(Activity activity) {
        Sheet sheet = pendingSheet;
        if (pendingFile == null || sheet == null || Build.VERSION.SDK_INT < 26) return;
        if (activity.getPackageManager().canRequestPackageInstalls()) {
            File file = pendingFile;
            String version = pendingVersion;
            pendingFile = null;
            pendingSheet = null;
            pendingVersion = null;
            commitInstall(sheet, file, version);
        } else {
            pendingFile = null;
            pendingSheet = null;
            failed(sheet, "Sin el permiso de instalar apps, Zer0Code no puede actualizarse sola. Actívalo y pulsa «Reintentar».");
        }
    }

    private static void commitInstall(final Sheet sheet, File file, String version) {
        final Activity activity = sheet.activity;
        final Context app = activity.getApplicationContext();
        try {
            PackageInstaller installer = app.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(app.getPackageName());
            params.setSize(file.length());
            // Android 12+: al actualizarse a sí misma no hace falta que el usuario confirme (si el sistema lo permite)
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int sessionId = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(sessionId)) {
                try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite("zer0code.apk", 0, file.length())) {
                    byte[] buffer = new byte[65536];
                    int n;
                    while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                    session.fsync(out);
                }

                BroadcastReceiver result = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context c, Intent intent) {
                        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                            if (confirm == null) return;
                            // Desde la actividad (en primer plano): Android no deja abrir pantallas desde segundo plano
                            if (alive(activity)) {
                                activity.startActivity(confirm);
                            } else {
                                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                c.startActivity(confirm);
                            }
                            MAIN.post(() -> sheet.setStatus("Confirma la actualización en la ventana de Android.", false));
                            return;
                        }
                        try {
                            app.unregisterReceiver(this);
                        } catch (Exception ignored) {
                            // ya estaba dado de baja
                        }
                        // Con éxito Android cierra la app para sustituirla: lo normal es no llegar aquí
                        if (status == PackageInstaller.STATUS_SUCCESS) return;
                        failed(sheet, explain(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)));
                    }
                };
                IntentFilter filter = new IntentFilter(ACTION_INSTALL_RESULT);
                if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(result, filter, Context.RECEIVER_NOT_EXPORTED);
                else app.registerReceiver(result, filter);

                // Se apunta antes de instalar: si al volver a abrir la app sigue la versión anterior, se avisa
                prefs(app).edit().putString(KEY_PENDING, version).remove(KEY_LAST_ERROR).apply();
                Intent resultIntent = new Intent(ACTION_INSTALL_RESULT).setPackage(app.getPackageName());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getBroadcast(app, sessionId, resultIntent, flags).getIntentSender());
                sheet.setStatus("Instalando… Zer0Code se cerrará un momento: vuelve a abrirla y ya tendrás la versión nueva.", false);
            }
        } catch (Exception e) {
            failed(sheet, "No se pudo instalar: " + e.getMessage());
        }
    }

    /** Motivo legible de un fallo de PackageInstaller */
    private static String explain(int status, String detail) {
        switch (status) {
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                return "Has cancelado la instalación. Pulsa «Reintentar» cuando quieras.";
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                return "Android no deja instalar la versión nueva encima de esta: la app instalada está firmada con otra clave "
                        + "(por ejemplo, una versión de prueba). Desinstala Zer0Code e instala el APK de GitHub una vez; "
                        + "a partir de ahí se actualizará sola."
                        + (detail == null ? "" : "\n\n(" + detail + ")");
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                return "No hay espacio suficiente para instalar la actualización.";
            case PackageInstaller.STATUS_FAILURE_INVALID:
                return "El APK descargado no es válido." + (detail == null ? "" : " (" + detail + ")");
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                return "El sistema ha bloqueado la instalación." + (detail == null ? "" : " (" + detail + ")");
            default:
                return "No se pudo instalar la actualización" + (detail == null ? "." : ": " + detail);
        }
    }

    // ------------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------------

    private static void openPage(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // sin navegador: nada que hacer
        }
    }

    private static String mb(long bytes) {
        return String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0);
    }

    private static String formatDate(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
            in.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date date = in.parse(iso);
            return date == null ? "" : new SimpleDateFormat("d MMM yyyy", new Locale("es", "ES")).format(date);
        } catch (Exception e) {
            return iso.length() >= 10 ? iso.substring(0, 10) : iso;
        }
    }

    /** Markdown sencillo de las notas del release (títulos, listas, negrita, código y enlaces) */
    static CharSequence formatNotes(String markdown) {
        StringBuilder html = new StringBuilder();
        boolean blank = false;
        for (String raw : markdown.replace("\r\n", "\n").split("\n")) {
            String line = raw.trim();
            if (line.isEmpty()) {
                if (!blank && html.length() > 0) html.append("<br>");
                blank = true;
                continue;
            }
            blank = false;
            if (line.startsWith("#")) {
                html.append("<b>").append(inline(line.replaceFirst("^#+\\s*", ""))).append("</b><br>");
            } else if (line.matches("^[-*+]\\s+.*")) {
                html.append("•&nbsp;&nbsp;").append(inline(line.replaceFirst("^[-*+]\\s+", ""))).append("<br>");
            } else {
                html.append(inline(line)).append("<br>");
            }
        }
        SpannableStringBuilder out = new SpannableStringBuilder(Html.fromHtml(html.toString(), Html.FROM_HTML_MODE_COMPACT));
        while (out.length() > 0 && Character.isWhitespace(out.charAt(out.length() - 1))) out.delete(out.length() - 1, out.length());
        return out;
    }

    private static String inline(String text) {
        return TextUtils.htmlEncode(text)
                .replaceAll("\\*\\*(.+?)\\*\\*", "<b>$1</b>")
                .replaceAll("`([^`]+)`", "<tt>$1</tt>")
                .replaceAll("\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\)", "<a href=\"$2\">$1</a>");
    }

    private static int dp(Context c, int value) {
        return Math.round(value * c.getResources().getDisplayMetrics().density);
    }

    private static TextView text(Context c, String value, int sp, int colorRes) {
        TextView view = new TextView(c);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(c.getColor(colorRes));
        view.setLineSpacing(0, 1.2f);
        return view;
    }

    private static Button button(Context c, boolean primary) {
        Button b = new Button(c);
        b.setAllCaps(false);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setStateListAnimator(null);
        b.setTextColor(c.getColor(primary ? R.color.accent_text : R.color.text));
        b.setBackground(rounded(c, primary ? R.color.accent : R.color.field, dp(c, 14), !primary));
        return b;
    }

    private static LinearLayout.LayoutParams buttonParams(Context c, int topMarginDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(c, 50));
        params.topMargin = dp(c, topMarginDp);
        return params;
    }

    private static GradientDrawable rounded(Context c, int colorRes, int radius, boolean border) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(c.getColor(colorRes));
        shape.setCornerRadius(radius);
        if (border) shape.setStroke(dp(c, 1), c.getColor(R.color.border));
        return shape;
    }
}
