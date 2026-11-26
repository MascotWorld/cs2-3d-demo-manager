package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"cs2-3d-demo-manager/internal/server"
	"cs2-3d-demo-manager/internal/store"
)

func main() {
	addr := flag.String("addr", envOr("CS2_ADDR", "127.0.0.1:4175"), "HTTP listen address")
	dataDir := flag.String("data", envOr("CS2_DATA_DIR", "./data"), "SQLite and cache directory")
	geoDirsRaw := flag.String("geo-dirs", envOr("CS2_GEO_DIRS", "./assets/geo"), "Comma-separated directories containing geo_<map>.bin(.gz)")
	assetDirsRaw := flag.String("asset-dirs", envOr("CS2_ASSET_DIRS", "./assets/maps"), "Comma-separated local folders containing <map>.glb, geo_<map>.bin(.gz), or radar images")
	staticDir := flag.String("static", envOr("CS2_STATIC_DIR", "./web/dist"), "Frontend dist directory")
	flag.Parse()

	st, err := store.Open(*dataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	splitDirs := func(raw string) []string {
		var out []string
		for _, d := range strings.Split(raw, ",") {
			d = strings.TrimSpace(d)
			if d != "" {
				if abs, err := filepath.Abs(d); err == nil {
					out = append(out, abs)
				} else {
					out = append(out, d)
				}
			}
		}
		return out
	}
	geoDirs := splitDirs(*geoDirsRaw)
	assetDirs := splitDirs(*assetDirsRaw)

	srv := server.New(server.Config{
		Store:     st,
		GeoDirs:   geoDirs,
		AssetDirs: assetDirs,
		StaticDir: *staticDir,
	})

	log.Printf("CS2 3D Demo Manager listening on http://%s (data=%s, geo=%v, assets=%v, static=%s)", *addr, *dataDir, geoDirs, assetDirs, *staticDir)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}
