package com.firewrks.tv;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Display-only cast receiver for the firewrks WebGPU show.
 *
 * The device this runs on (e.g. an Android TV) usually has no WebGPU, so it does NOT render the
 * show — it connects to a host machine that renders with WebGPU and publishes the frames over
 * WebRTC, and plays the incoming <video> track. See docs/webrtc-cast.md and docs/architecture.md.
 *
 * On launch it shows a small config screen to enter the host's <ip>:<port> (persisted across
 * runs), then loads that host's /tv receiver page. Two overrides exist for automation/dev:
 *   - intent extra `url`   : load an explicit URL (e.g. adb am start ... -e url http://host:8765/tv)
 *   - intent extra `host`  : load http://<host>/tv directly, skipping the config screen
 *
 * A future version can auto-discover the host via mDNS (_firewrks._tcp) instead of manual entry.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "firewrks";
    private static final String KEY_HOST = "host";
    private static final int DEFAULT_PORT = 8765;
    private static final String APP_ORIGIN = "appassets.local"; // bundled-show asset scheme host
    private static final String SERVICE_TYPE = "_firewrks._tcp."; // mDNS/DNS-SD service type

    private WebView webView;
    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;
    private WifiManager.MulticastLock multicastLock;
    private TextView statusView;      // config-screen "searching / found" line
    private boolean connecting;       // guards against double auto-connect

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String url = getIntent().getStringExtra("url");
        String host = getIntent().getStringExtra("host");
        if (url != null && !url.isEmpty()) { loadUrl(url); return; }
        if (host != null && !host.isEmpty()) { connect(host); return; }
        showConfig();
    }

    // ---------------------------------------------------------------------------
    // Config screen: enter <ip>:<port> of the machine running `npm run cast`.
    // ---------------------------------------------------------------------------

    private void showConfig() {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString(KEY_HOST, "");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.BLACK);
        int pad = dp(32);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("firewrks");
        title.setTextColor(0xFFFFD27A);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        title.setGravity(Gravity.CENTER);

        TextView hint = new TextView(this);
        hint.setText("Searching the network\u2026 or enter the host ( ip:port )");
        hint.setTextColor(0xFFB0B0B0);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(8), 0, dp(20));

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("192.168.1.50:" + DEFAULT_PORT);
        input.setText(saved);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(0xFF666666);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        input.setGravity(Gravity.CENTER);
        input.setSingleLine(true);
        input.setWidth(dp(360));

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String host = input.getText().toString().trim();
                if (host.isEmpty()) return;
                prefs.edit().putString(KEY_HOST, host).apply();
                connect(host);
            }
        });
        LinearLayout.LayoutParams btnLp =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(20);
        connect.setLayoutParams(btnLp);

        statusView = new TextView(this);
        statusView.setTextColor(0xFF6FCF6F);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(0, dp(18), 0, 0);

        root.addView(title);
        root.addView(hint);
        root.addView(input);
        root.addView(connect);
        root.addView(statusView);
        setContentView(root);

        input.requestFocus();
        connecting = false;
        startDiscovery();
    }

    /** Normalizes `host` (adds default port) and loads its /tv receiver page. */
    private void connect(String host) {
        stopDiscovery();
        String h = host.trim();
        if (!h.contains(":")) h = h + ":" + DEFAULT_PORT; // default port if only an IP was given
        loadUrl("http://" + h + "/tv");
    }

    // ---------------------------------------------------------------------------
    // mDNS / DNS-SD auto-discovery (NsdManager): find a host advertising `_firewrks._tcp` and
    // connect automatically, so the user never has to type an ip:port. Manual entry stays as a
    // fallback. See server/stream.mjs (advertiseMdns) for the host side.
    // ---------------------------------------------------------------------------

    private void startDiscovery() {
        stopDiscovery(); // idempotent: never stack two discovery listeners
        try {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null && multicastLock == null) {
                multicastLock = wifi.createMulticastLock("firewrks-mdns");
                multicastLock.setReferenceCounted(true);
                multicastLock.acquire();
            }
            nsdManager = (NsdManager) getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) return;
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override public void onServiceFound(NsdServiceInfo info) {
                    if (info.getServiceType() != null && info.getServiceType().contains("firewrks")) {
                        try { nsdManager.resolveService(info, newResolveListener()); } catch (Exception ignored) {}
                    }
                }
                @Override public void onServiceLost(NsdServiceInfo info) {}
                @Override public void onDiscoveryStarted(String t) {}
                @Override public void onDiscoveryStopped(String t) {}
                @Override public void onStartDiscoveryFailed(String t, int code) {}
                @Override public void onStopDiscoveryFailed(String t, int code) {}
            };
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception ignored) { /* discovery is best-effort; manual entry always works */ }
    }

    /** A fresh ResolveListener per resolve call (NsdManager requires it). On success, auto-connects
     * to the first host found. */
    private NsdManager.ResolveListener newResolveListener() {
        return new NsdManager.ResolveListener() {
            @Override public void onServiceResolved(NsdServiceInfo info) {
                if (info.getHost() == null) return;
                final String hostPort = info.getHost().getHostAddress() + ":" + info.getPort();
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        if (connecting) return;
                        connecting = true;
                        if (statusView != null) statusView.setText("Found " + hostPort + " \u2014 connecting\u2026");
                        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_HOST, hostPort).apply();
                        connect(hostPort);
                    }
                });
            }
            @Override public void onResolveFailed(NsdServiceInfo info, int code) {}
        };
    }

    private void stopDiscovery() {
        if (nsdManager != null && discoveryListener != null) {
            try { nsdManager.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
        }
        discoveryListener = null;
        if (multicastLock != null && multicastLock.isHeld()) {
            try { multicastLock.release(); } catch (Exception ignored) {}
        }
        multicastLock = null;
    }

    // ---------------------------------------------------------------------------
    // WebView receiver.
    // ---------------------------------------------------------------------------

    private void loadUrl(String url) {
        WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // Kiosk playback has no user gesture — allow the received media (and, for the bundled show,
        // its WebAudio context) to start on its own.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.setBackgroundColor(Color.BLACK);
        webView.setWebViewClient(new AssetClient());
        setContentView(webView);
        enterImmersive();
        webView.loadUrl(url);
    }

    /** Serves the OPTIONAL bundled WebGPU show from assets over a synthetic https origin (secure
     * context, no file:// CORS). Only used when a URL points at that origin; remote cast URLs pass
     * straight through to the network. */
    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!APP_ORIGIN.equals(uri.getHost())) return null;
            String path = uri.getPath();
            if (path == null || path.equals("/")) path = "/index.html";
            String assetPath = path.startsWith("/") ? path.substring(1) : path;
            try {
                InputStream in = getAssets().open(assetPath);
                Map<String, String> headers = new HashMap<>();
                headers.put("Access-Control-Allow-Origin", "*");
                WebResourceResponse resp = new WebResourceResponse(mimeFor(assetPath), "UTF-8", in);
                resp.setResponseHeaders(headers);
                return resp;
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "UTF-8",
                        404, "Not Found", new HashMap<String, String>(), null);
            }
        }
    }

    /** Minimal extension->MIME map. `.js`/`.mjs` MUST be a JS MIME or ES modules refuse to run. */
    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** D-pad center / Enter / remote OK fires one interactive shell (bundled-show path only). */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (webView != null && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_BUTTON_A)) {
            webView.evaluateJavascript(
                "(function(){var c=document.querySelector('canvas');if(!c)return;"
              + "var r=c.getBoundingClientRect();"
              + "c.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+Math.random()*r.width,"
              + "clientY:r.top+r.height*0.5,bubbles:true}));})();", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /** BACK returns from the player to the host-config screen instead of exiting. */
    @Override
    public void onBackPressed() {
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
            showConfig();
            return;
        }
        super.onBackPressed();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void enterImmersive() {
        webView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && webView != null) enterImmersive();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        stopDiscovery();
        super.onDestroy();
    }
}
