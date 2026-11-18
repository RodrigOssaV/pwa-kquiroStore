# KQuiro Scanner

PWA para registrar productos con el celular escaneando códigos de barra, y exportar un Excel
que la app de escritorio de KQuiro importa sin cambios.

- Sin servidor ni backend: todo queda guardado en el teléfono (IndexedDB).
- Funciona **100 % sin internet** después de la primera carga (service worker).
- HTML + CSS + JavaScript puro (ES modules). Sin framework y sin paso de compilación.

## Estructura

```
index.html             Página única con las 4 pantallas
manifest.webmanifest   Datos de la PWA (nombre, íconos, colores)
sw.js                  Service worker: caché de la app y de las librerías del CDN
css/styles.css         Estilos (modo oscuro automático)
js/app.js              Interfaz y flujo de la app
js/db.js               IndexedDB (lista, catálogo, historial, ajustes)
js/scanner.js          Cámara y lectura de códigos (html5-qrcode)
js/excel.js            Exportar e importar .xlsx (SheetJS)
js/util.js             Formato CLP, normalización de nombres, consolidación
icons/                 Íconos de la app
tools/make-icons.mjs   Regenera los PNG de icons/ (node tools/make-icons.mjs)
```

Librerías (versión fija, cargadas desde CDN y guardadas en caché por el service worker):

| Librería     | Versión | URL |
|--------------|---------|-----|
| html5-qrcode | 2.3.8   | `https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js` |
| SheetJS      | 0.20.3  | `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js` |

Si cambias una versión, actualiza la URL **en `index.html` y en `sw.js`** (deben ser idénticas).

## Formato exacto del Excel exportado

La app de escritorio solo lee la **primera hoja**. Si el archivo no cumple esto, la importación falla.

- Una sola hoja, llamada `productos`.
- Fila 1 = encabezados, exactamente así y en este orden:

  | A          | B          | C        | D               | E                |
  |------------|------------|----------|-----------------|------------------|
  | `producto` | `cantidad` | `precio` | `codigo_barras` | `fecha_registro` |

  Las columnas D y E son adicionales; la app de escritorio las ignora.
- `producto`: celda de **texto**, en MAYÚSCULAS, sin espacios al inicio/fin ni dobles. Nunca vacía.
- `cantidad`: celda **numérica**, entero ≥ 0.
- `precio`: celda **numérica**, entero ≥ 0, pesos chilenos sin decimales.
- `codigo_barras`: celda de **texto** con formato `@`, para conservar ceros a la izquierda
  (`0012345678905`) y evitar la notación científica. Vacía si el producto no tiene código.
- `fecha_registro`: texto `AAAA-MM-DD HH:mm` (hora local del teléfono, momento del primer registro).
- **Una fila por producto.** Si un código se escanea varias veces, las cantidades se suman en
  una sola fila. Los productos sin código se agrupan por nombre.
- Sin filas vacías, sin totales, sin fórmulas, sin celdas combinadas.
- Nombre del archivo: `kquiro_productos_AAAA-MM-DD_HHmm.xlsx` (ej. `kquiro_productos_2026-11-18_1432.xlsx`).

Ejemplo:

| producto       | cantidad | precio | codigo_barras  | fecha_registro   |
|----------------|----------|--------|----------------|------------------|
| COCA COLA 1.5L | 12       | 1990   | 7801610001196  | 2026-11-18 14:32 |
| GALLETAS OREO  | 30       | 890    | 7622300489434  | 2026-11-18 14:35 |

### Importar catálogo

En **Catálogo → Importar Excel** se puede cargar un .xlsx con el mismo formato para precargar
productos conocidos. Se usan `producto`, `precio` y `codigo_barras`; `cantidad` se ignora.
Los encabezados se aceptan con mayúsculas o tildes (`Código Barras` → `codigo_barras`).
Las filas sin código o sin nombre se omiten. Si en el archivo el código es una celda numérica,
los ceros a la izquierda ya se habían perdido en ese archivo y no se pueden recuperar.

## Probar en local

La cámara solo funciona en un **contexto seguro**: `https://` o `http://localhost`.

### En el computador

Cualquier servidor estático sirve, porque `localhost` cuenta como seguro:

```bash
npx serve .
# o
python -m http.server 8080
```

Abre `http://localhost:3000` (o `:8080`). Con la cámara del notebook puedes probar el escáner
mostrando un código en el celular.

### En el celular

Opción recomendada (Android + Chrome), sin certificados:

1. Levanta el servidor en el PC (`npx serve .` → puerto 3000).
2. Conecta el teléfono por USB con la depuración USB activada.
3. En el PC abre `chrome://inspect/#devices` → **Port forwarding** → `3000` → `localhost:3000`.
4. En el teléfono abre `http://localhost:3000`. Es `localhost`, así que la cámara funciona.

Opción con HTTPS en la red local (Android e iPhone):

```bash
# 1. Certificado de confianza local con mkcert (https://github.com/FiloSottile/mkcert)
mkcert -install
mkcert 192.168.1.50 localhost        # usa la IP de tu PC

# 2. Servir con HTTPS
npx http-server . -S -C 192.168.1.50+1.pem -K 192.168.1.50+1-key.pem -p 8443 -c-1
```

Abre `https://192.168.1.50:8443` en el teléfono. Para que el teléfono confíe en el certificado,
instala en él la CA de mkcert (`mkcert -CAROOT` muestra dónde está `rootCA.pem`). En iPhone
además hay que activarla en Ajustes → General → Información → Ajustes de confianza de certificados.

Opción más simple para una prueba rápida: un túnel HTTPS como `npx cloudflared tunnel --url http://localhost:3000`,
que entrega una URL `https://...trycloudflare.com` válida en cualquier teléfono.

> Al probar cambios, el service worker sirve la versión en caché. En Chrome usa DevTools →
> Application → Service Workers → **Update on reload**, o sube `VERSION` en `sw.js`.

## Publicar en GitHub Pages

1. Sube el repositorio a GitHub (los archivos deben quedar en la raíz).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   rama `main`, carpeta `/ (root)` → **Save**.
3. En uno o dos minutos la app queda en `https://<usuario>.github.io/<repositorio>/`.

Todas las rutas son relativas, así que funciona dentro de la subcarpeta del repositorio sin configurar nada.
GitHub Pages sirve por HTTPS, que es lo que necesita la cámara.

**Al publicar una nueva versión** sube el número de `VERSION` en `sw.js` (ej. `v1.0.1`).
Los teléfonos descargan la versión nueva la próxima vez que abran la app con internet y la
usan desde la apertura siguiente.

## Instalar la app en el teléfono

Ábrela una vez **con internet** para que se guarde todo en el teléfono.

**Android (Chrome)**
1. Abre la dirección de la app en Chrome.
2. Toca **Instalar** en el aviso, o menú ⋮ → **Instalar app** / **Agregar a la pantalla principal**.
3. Aparece el ícono **KQuiro Scanner**. Al abrirla pedirá permiso de cámara: toca **Permitir**.

**iPhone (Safari, iOS 15 o superior)**
1. Abre la dirección de la app en **Safari** (en iOS 15/16 tiene que ser Safari).
2. Toca el botón **Compartir** (cuadrado con flecha) → **Agregar a inicio** → **Agregar**.
3. Abre la app desde el ícono y permite el acceso a la cámara.

Si se negó el permiso de cámara, la app lo indica y permite seguir escribiendo códigos a mano.
Para reactivarlo:
- Android: candado junto a la dirección (o mantener presionado el ícono → Información de la app) → Permisos → Cámara.
- iPhone: Ajustes → Safari → Cámara → Permitir (o Ajustes → Privacidad → Cámara).

## Uso

1. **Escanear**: toca *Escanear*, apunta al código. Vibra (y pita si está activado) al leerlo.
   - Código conocido → nombre y precio precargados, el cursor queda en *Cantidad*.
   - Código nuevo → escribe nombre y precio; queda guardado en el catálogo.
   - Si el producto ya está en la lista, pregunta si **sumar** la cantidad o **reemplazarla**.
   - *Escribir el código*: cuando la cámara no lo lee. *Producto sin código*: solo con nombre.
   - *Modo rápido*: cada lectura de un producto conocido suma +1 sin abrir la ficha.
2. **Lista**: totales (productos, unidades, valor en CLP), buscador, editar y eliminar.
3. **Exportar**: genera el Excel. Si el teléfono lo permite abre el menú de compartir
   (WhatsApp, correo, Drive); si no, lo descarga. Después ofrece vaciar la lista
   (el catálogo nunca se borra). Cada exportación queda en el **historial** para volver a descargarla.
4. **Catálogo**: ver, corregir o eliminar productos conocidos, e importar desde Excel.

### Datos y respaldo

- Todo se guarda en IndexedDB del navegador y sobrevive a cerrar la app o reiniciar el teléfono.
- La app pide almacenamiento persistente (`navigator.storage.persist()`); el estado se ve en *Exportar*.
- Un aviso en la lista y un número en la pestaña *Exportar* indican productos con cambios sin exportar.
- **Los datos viven solo en ese teléfono y en ese navegador.** Borrar los datos de navegación o
  desinstalar la app los elimina. En iPhone, la app instalada y Safari guardan datos por separado:
  lo registrado en Safari no aparece en la app instalada, y viceversa.
  Exporta con frecuencia: el Excel es el respaldo.

## Compatibilidad y notas

- Chrome Android y Safari iOS 15+, en el navegador o instalada.
- En Chrome Android se usa el lector nativo de códigos (`BarcodeDetector`) cuando existe,
  que es más rápido; si no, html5-qrcode decodifica en JavaScript.
- Compartir archivos depende del navegador: si `navigator.canShare({ files })` no acepta el
  `.xlsx`, la app lo descarga y se puede compartir desde la carpeta Descargas.
- Formatos leídos: EAN-13, EAN-8, UPC-A, UPC-E, Code 128 y Code 39.
