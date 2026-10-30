package es.zer0dev.zer0code;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

/**
 * App de Android de Zer0Code: pide la dirección del servidor la primera vez, comprueba que es
 * un Zer0Code y abre la web a pantalla completa. Cada instalación se conecta a su propio servidor.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "zer0code";
    private static final String KEY_SERVER = "server_url";
    private static final int FILE_REQUEST = 1;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView webView;
    private View errorView;
    private ValueCallback<Uri[]> fileCallback;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));
        applySystemInsets(root);
        setContentView(root);

        serverUrl = prefs().getString(KEY_SERVER, null);
        if (serverUrl == null) showSetup(null);
        else showWeb();
        // ¿Se acaba de actualizar (novedades) o falló la última actualización?
        Updater.onAppStart(this);
    }

    // ------------------------------------------------------------------------
    // Pantalla de elegir servidor
    // ------------------------------------------------------------------------
    private void showSetup(String message) {
        destroyWebView();
        root.removeAllViews();

        // Misma tarjeta que el login de la web: logo Z0, título, campo con etiqueta y botón oscuro
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(24), dp(24), dp(24), dp(24));
        column.setBackground(card());
        column.setElevation(dp(6));

        TextView logo = text("Z0", 22, R.color.bg);
        logo.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        logo.setGravity(Gravity.CENTER);
        logo.setBackground(rounded(R.color.text, dp(14), false));
        column.addView(logo, new LinearLayout.LayoutParams(dp(56), dp(56)));

        TextView title = text("Zer0Code", 28, R.color.text);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        column.addView(title, matchWidth(dp(20)));

        TextView intro = text("Introduce la dirección de tu servidor de Zer0Code para acceder desde este dispositivo.", 14, R.color.muted);
        intro.setGravity(Gravity.CENTER);
        column.addView(intro, matchWidth(dp(8)));

        TextView label = text("Servidor", 13, R.color.text);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(label, matchWidth(dp(24)));

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setHint("https://…");
        input.setTextColor(getColor(R.color.text));
        input.setHintTextColor(getColor(R.color.muted));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        input.setBackground(rounded(R.color.field, dp(12), true));
        String last = prefs().getString(KEY_SERVER, null);
        if (last != null) input.setText(last);
        column.addView(input, matchWidth(dp(8)));

        TextView status = text(message == null ? "" : message, 13, R.color.error);
        status.setGravity(Gravity.CENTER);
        column.addView(status, matchWidth(dp(12)));

        Button connect = new Button(this);
        connect.setText("Conectar");
        connect.setAllCaps(false);
        connect.setTypeface(Typeface.DEFAULT_BOLD);
        connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        connect.setTextColor(getColor(R.color.accent_text));
        connect.setBackground(rounded(R.color.accent, dp(12), false));
        column.addView(connect, buttonParams(dp(12)));

        TextView hint = text("La dirección aparece al arrancar el servidor, por ejemplo https://mi-servidor.tailnet.ts.net o http://192.168.1.50:5050.", 12, R.color.muted);
        hint.setGravity(Gravity.CENTER);
        column.addView(hint, matchWidth(dp(16)));

        // Versión instalada: abre las novedades (y desde ahí, buscar actualizaciones)
        TextView version = text("v" + BuildConfig.VERSION_NAME + "  ·  Novedades", 12, R.color.muted);
        version.setTypeface(Typeface.MONOSPACE);
        version.setGravity(Gravity.CENTER);
        version.setPadding(dp(14), dp(6), dp(14), dp(6));
        version.setBackground(rounded(R.color.field, dp(999), true));
        version.setOnClickListener(v -> Updater.showWhatsNew(this, null));
        LinearLayout.LayoutParams versionParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        versionParams.topMargin = dp(16);
        versionParams.gravity = Gravity.CENTER_HORIZONTAL;
        column.addView(version, versionParams);

        View.OnClickListener go = v -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                status.setText("Escribe una dirección.");
                return;
            }
            connect.setEnabled(false);
            status.setTextColor(getColor(R.color.muted));
            status.setText("Conectando…");
            io.execute(() -> {
                String error = checkServer(url);
                main.post(() -> {
                    if (error == null) {
                        serverUrl = url;
                        prefs().edit().putString(KEY_SERVER, url).apply();
                        showWeb();
                    } else {
                        connect.setEnabled(true);
                        status.setTextColor(getColor(R.color.error));
                        status.setText(error);
                    }
                });
            });
        };
        connect.setOnClickListener(go);
        input.setOnEditorActionListener((v, actionId, event) -> {
            go.onClick(v);
            return true;
        });

        // La tarjeta va centrada sobre el fondo de la página, con margen a los lados
        FrameLayout page = new FrameLayout(this);
        page.setPadding(dp(20), dp(20), dp(20), dp(20));
        page.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(page);
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** Añade https:// si falta (http:// para IPs de la red local) y quita la barra final. */
    private static String normalize(String raw) {
        String url = raw.trim();
        if (url.isEmpty()) return null;
        if (!url.contains("://")) {
            boolean lanAddress = url.matches("^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?(/.*)?$") || url.startsWith("localhost");
            url = (lanAddress ? "http://" : "https://") + url;
        }
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    /** Devuelve null si la dirección es un servidor de Zer0Code, o el motivo por el que no. */
    private static String checkServer(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url + "/manifest.json").openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            int code = connection.getResponseCode();
            if (code != 200) return "El servidor ha respondido con el código " + code + ".";
            String body = readUpTo(connection.getInputStream(), 64 * 1024);
            if (!body.contains("\"start_url\"")) return "Esa dirección responde, pero no es un servidor de Zer0Code.";
            return null;
        } catch (UnknownHostException e) {
            return "No se encuentra el servidor. Revisa la dirección y, si usas Tailscale, que esté activo en el móvil.";
        } catch (SSLException e) {
            return "El certificado HTTPS del servidor no es válido.";
        } catch (ConnectException e) {
            return "No hay ningún servidor de Zer0Code en esa dirección. Comprueba que está arrancado, el puerto y que el móvil está en la misma red (o con Tailscale activo).";
        } catch (SocketTimeoutException e) {
            return "El servidor no responde. Comprueba que el móvil llega a él (misma Wi-Fi o Tailscale activo).";
        } catch (IOException | IllegalArgumentException e) {
            return "No se puede conectar: " + e.getMessage();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readUpTo(InputStream in, int limit) throws IOException {
        byte[] buffer = new byte[limit];
        int total = 0;
        int read;
        while (total < limit && (read = in.read(buffer, total, limit - total)) != -1) total += read;
        in.close();
        return new String(buffer, 0, total, StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------------
    // Web
    // ------------------------------------------------------------------------
    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void showWeb() {
        destroyWebView();
        root.removeAllViews();

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.bg));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // La web usa esta marca y el puente para ofrecer «Cambiar de servidor»
        settings.setUserAgentString(settings.getUserAgentString() + " Zer0CodeAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        webView.addJavascriptInterface(new Bridge(), "Zer0CodeAndroid");
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());

        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.loadUrl(serverUrl);
        // ¿Hay una versión nueva de la app? (como mucho cada 6 horas)
        Updater.check(this, false);
    }

    private void showError(String detail) {
        if (errorView != null) root.removeView(errorView);

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(dp(28), dp(28), dp(28), dp(28));
        column.setBackgroundColor(getColor(R.color.bg));
        column.setClickable(true);

        TextView title = text("No se puede abrir Zer0Code", 22, R.color.text);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        column.addView(title, matchWidth(0));

        TextView info = text(serverUrl + "\n\n" + detail + "\n\nComprueba que el servidor está encendido y que el móvil llega a él (misma Wi-Fi o Tailscale activo).", 15, R.color.muted);
        info.setGravity(Gravity.CENTER);
        column.addView(info, matchWidth(dp(12)));

        Button retry = new Button(this);
        retry.setText("Reintentar");
        retry.setAllCaps(false);
        retry.setTextColor(getColor(R.color.accent_text));
        retry.setBackground(rounded(R.color.accent, dp(14), false));
        retry.setOnClickListener(v -> {
            root.removeView(errorView);
            errorView = null;
            if (webView != null) webView.loadUrl(serverUrl);
        });
        column.addView(retry, matchWidth(dp(24)));

        Button change = new Button(this);
        change.setText("Cambiar de servidor");
        change.setAllCaps(false);
        change.setTextColor(getColor(R.color.text));
        change.setBackground(rounded(R.color.field, dp(14), true));
        change.setOnClickListener(v -> showSetup(null));
        column.addView(change, matchWidth(dp(10)));

        errorView = column;
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private boolean isServerUrl(Uri uri) {
        Uri server = Uri.parse(serverUrl);
        return server.getScheme() != null && server.getScheme().equalsIgnoreCase(uri.getScheme())
                && server.getHost() != null && server.getHost().equalsIgnoreCase(uri.getHost())
                && server.getPort() == uri.getPort();
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isServerUrl(uri)) return false;
            // Enlaces externos: en el navegador del móvil
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            showError("El certificado HTTPS del servidor no es válido.");
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(intent, FILE_REQUEST);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }
    }

    /** Puente con la web: window.Zer0CodeAndroid.changeServer() */
    private class Bridge {
        @JavascriptInterface
        public void changeServer() {
            main.post(() -> showSetup(null));
        }

        /** window.Zer0CodeAndroid.checkUpdates(): buscar una versión nueva de la app ahora */
        @JavascriptInterface
        public void checkUpdates() {
            main.post(() -> Updater.check(MainActivity.this, true));
        }

        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }

        /** window.Zer0CodeAndroid.showWhatsNew(): novedades de la app y actualizar */
        @JavascriptInterface
        public void showWhatsNew() {
            main.post(() -> Updater.showWhatsNew(MainActivity.this, null));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_REQUEST || fileCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (errorView == null && webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Volvemos de conceder el permiso de instalar apps: seguir con la actualización descargada
        Updater.onResume(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        io.shutdownNow();
        super.onDestroy();
    }

    private void destroyWebView() {
        errorView = null;
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
    }

    // ------------------------------------------------------------------------
    // Utilidades de interfaz
    // ------------------------------------------------------------------------

    /** Deja hueco para la barra de estado, la de navegación y el teclado (Android 15 dibuja de borde a borde). */
    private static void applySystemInsets(View view) {
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String value, int sp, int colorRes) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(getColor(colorRes));
        view.setLineSpacing(0, 1.2f);
        return view;
    }

    private LinearLayout.LayoutParams matchWidth(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = topMargin;
        return params;
    }

    private LinearLayout.LayoutParams buttonParams(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        params.topMargin = topMargin;
        return params;
    }

    private GradientDrawable card() {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(getColor(R.color.card));
        shape.setCornerRadius(dp(24));
        shape.setStroke(dp(1), getColor(R.color.border));
        return shape;
    }

    private GradientDrawable rounded(int colorRes, int radius, boolean border) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(getColor(colorRes));
        shape.setCornerRadius(radius);
        if (border) shape.setStroke(dp(1), getColor(R.color.border));
        return shape;
    }
}
