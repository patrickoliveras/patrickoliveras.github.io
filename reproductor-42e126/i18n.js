/* Every word on the page, in Mexican Spanish (default) and English.
 * Keys are checked by tests: both languages must define the same keys and
 * the same {placeholders}. */

export const STRINGS = {
  es: {
    'doc.title': 'Videos para el reproductor',
    'lang.switch': 'English',
    'lang.switchLabel': 'Ver la página en inglés',

    'hero.title': 'Lleva tus videos al reproductor',
    'hero.lede': 'Elige un video y lo dejamos listo para tu reproductor ZUSZOX.',
    'hero.choose': 'Elegir video',
    'hero.drop': 'o arrástralo aquí',
    'hero.dropActive': 'Suéltalo aquí',
    'hero.privacy.computer': 'Tu video no se sube a internet: se convierte aquí, en tu computadora.',
    'hero.privacy.phone': 'Tu video no se sube a internet: se convierte aquí, en tu celular.',
    'hero.privacy.tablet': 'Tu video no se sube a internet: se convierte aquí, en tu tableta.',
    'steps.1': 'Elige el video',
    'steps.2': 'Espera a que se convierta',
    'steps.3': 'Pásalo al reproductor',

    'engine.preparing': 'Preparando el convertidor…',
    'engine.preparingPct': 'Preparando el convertidor… {pct}',
    'engine.firstTime': 'Esto solo tarda la primera vez.',
    'engine.offline': 'Sin conexión a internet. Lo intentamos de nuevo en cuanto vuelva.',

    'item.checking': 'Revisando el video…',
    'item.waiting': 'En espera',
    'item.converting': 'Convirtiendo…',
    'item.convertingPct': 'Convirtiendo… {pct}',
    'item.retrying': 'Un momento, lo intentamos de otra forma…',
    'item.eta.calculating': 'Calculando cuánto falta…',
    'item.eta.lessThanMinute': 'Falta menos de un minuto',
    'item.eta.minutes': 'Faltan unos {n} minutos',
    'item.eta.oneMinute': 'Falta como un minuto',
    'item.eta.hours': 'Falta como {h} h {m} min',
    'item.keepOpen': 'Puedes hacer otra cosa mientras tanto. Solo no cierres esta página.',
    'item.keepVisible': 'Este video necesita que dejes esta página a la vista mientras se convierte.',
    'item.cancel': 'Cancelar',
    'item.remove': 'Quitar',

    'fit.label': 'Imagen',
    'fit.fit': 'Completa',
    'fit.fitHint': 'Se ve todo, con franjas negras',
    'fit.fill': 'Pantalla llena',
    'fit.fillHint': 'Llena la pantalla y recorta las orillas',

    'done.title': '¡Listo!',
    'done.lede': 'Ya puedes pasarlo al reproductor.',
    'done.verified': 'Comprobado: tiene el formato que abre tu reproductor.',
    'done.tooBig': 'Ojo: pesa más de 4 GB, y la tarjeta del reproductor no acepta archivos tan grandes. Si puedes, recorta el video en partes antes de convertirlo.',
    'done.saveToPlayer': 'Guardar en el reproductor',
    'done.saveToComputer': 'Guardar en la computadora',
    'done.save': 'Guardar video',
    'done.saveAll': 'Guardar los {n} videos',
    'done.share': 'Compartir',
    'done.another': 'Convertir otro video',
    'done.play': 'Ver cómo quedó',
    'done.pause': 'Pausar',
    'done.playLabel': 'Reproducir la vista previa',

    'saved.downloads': 'Guardado en tu carpeta de Descargas.',
    'saved.player': 'Guardado en el reproductor, en {where}.',

    'player.pickTitle': 'Elige la tarjeta del reproductor',
    'player.pickHelp.mac': 'Conecta el reproductor con su cable. Se abrirá una ventana: a la izquierda elige «Untitled 1» (la tarjeta), abre la carpeta «Videos» y pulsa «Seleccionar».',
    'player.pickHelp.windows': 'Conecta el reproductor con su cable. Se abrirá una ventana: elige la unidad del reproductor que es la tarjeta (la más grande), abre su carpeta «Videos» y pulsa «Seleccionar carpeta».',
    'player.pickHelp.other': 'Conecta el reproductor con su cable. Se abrirá una ventana: elige la tarjeta del reproductor (el disco más grande), abre su carpeta «Videos» y confírmalo.',
    'player.pick': 'Elegir el reproductor',
    'player.internalWarning': 'Esa parece la memoria interna del reproductor. Es mejor la tarjeta: el disco «Untitled 1», el más grande.',
    'player.useAnyway': 'Guardar aquí de todos modos',
    'player.chooseOther': 'Elegir otro disco',
    'player.permission': 'Después, el navegador te pedirá permiso para guardar ahí: acéptalo.',

    'copy.title': 'Ahora pásalo al reproductor',
    'copy.titleDone': 'Antes de desconectarlo',
    'copy.connect': 'Conecta el reproductor a la computadora con su cable.',
    'copy.open.mac': 'En el Finder, en la barra de la izquierda, aparecen dos discos: «Untitled» y «Untitled 1». Abre «Untitled 1»: es la tarjeta de memoria. Luego abre la carpeta «Videos».',
    'copy.open.windows': 'Abre «Este equipo». Verás dos unidades nuevas: abre la más grande (es la tarjeta de memoria) y luego la carpeta «Videos».',
    'copy.open.other': 'Abre el disco del reproductor que es la tarjeta de memoria (el más grande) y luego la carpeta «Videos».',
    'copy.drag': 'Arrastra ahí el video «{name}» desde tu carpeta de Descargas.',
    'copy.eject.mac': 'Antes de desconectar el cable, expulsa los dos discos: haz clic en ⏏ junto a cada uno.',
    'copy.eject.windows': 'Antes de desconectar el cable, expulsa las dos unidades: clic derecho sobre cada una y «Expulsar».',
    'copy.eject.other': 'Antes de desconectar el cable, expulsa los discos del reproductor.',
    'copy.watch': 'En el reproductor, entra a «Vídeo» y elige «{title}». El Bluetooth tiene que estar apagado para ver videos.',
    'copy.phone': 'Para pasarlo al reproductor necesitas una computadora. Guarda el video y mándatelo, o ábrelo desde la computadora.',

    'err.title.empty': 'Este archivo está vacío',
    'err.body.empty': 'No tiene nada adentro. Quizá no se terminó de copiar o de descargar.',
    'err.title.image': 'Esto es una foto, no un video',
    'err.body.image': 'Elige un archivo de video.',
    'err.title.document': 'Este archivo no es un video',
    'err.body.document': 'Parece un documento. Elige un archivo de video.',
    'err.title.archive': 'Es un archivo comprimido',
    'err.body.archive': 'Ábrelo primero (doble clic) y luego elige el video que trae adentro.',
    'err.title.not-media': 'Este archivo no es un video',
    'err.body.not-media': 'No encontramos imagen ni sonido. Elige un archivo de video.',
    'err.title.already-amv': 'Este video ya está listo',
    'err.body.already-amv': 'Ya tiene el formato del reproductor (.amv). No hace falta convertirlo: cópialo tal cual.',
    'err.title.unreadable': 'No pudimos leer este video',
    'err.body.unreadable': 'Puede estar dañado o en un formato muy raro. Prueba con otra copia del mismo video.',
    'err.title.incomplete': 'Este video está incompleto',
    'err.body.incomplete': 'Parece que no se terminó de descargar o de copiar. Vuelve a bajarlo y prueba otra vez.',
    'err.title.undecodable': 'Este video viene en un formato que aún no podemos convertir',
    'err.body.undecodable': 'Si lo bajaste de internet, prueba bajarlo otra vez en MP4 (por ejemplo, en 720p).',
    'err.title.no-frames': 'Este video no tiene imagen',
    'err.body.no-frames': 'No encontramos ninguna imagen que convertir.',
    'err.title.out-of-memory': 'Tu equipo se quedó sin memoria',
    'err.body.out-of-memory': 'Cierra otras ventanas o pestañas y vuelve a intentarlo.',
    'err.title.engine-unavailable': 'No se pudo preparar el convertidor',
    'err.body.engine-unavailable': 'Revisa tu conexión a internet y vuelve a intentarlo.',
    'err.title.browser-unsupported': 'Este navegador es muy antiguo',
    'err.body.browser-unsupported': 'Abre esta página en Chrome, Edge, Firefox o Safari, actualizados.',
    'err.title.save-failed': 'No se pudo guardar',
    'err.body.save-failed': 'Revisa que el reproductor siga conectado y que tenga espacio, y vuelve a intentarlo.',
    'err.title.internal': 'Algo salió mal al convertir',
    'err.body.internal': 'Vuelve a intentarlo. Si sigue pasando, copia los detalles y mándaselos a quien te ayuda.',
    'err.retry': 'Intentar de nuevo',
    'err.other': 'Elegir otro video',
    'err.details': 'Detalles técnicos',
    'err.copy': 'Copiar detalles',
    'err.copied': 'Copiado',

    'leave.warning': 'Se está convirtiendo un video. Si sales, se pierde.',
    'tab.done': '✓ Listo — {title}',
    'tab.progress': '{pct} · Convirtiendo',

    'list.title': 'Tus videos',
    'list.summary': '{done} de {total} listos',

    'faq.title': 'Preguntas',
    'faq.why.q': '¿Por qué hay que convertir los videos?',
    'faq.why.a': 'Tu reproductor solo abre videos en su propio formato (AMV, de 320 × 240). Los videos del celular o de internet vienen en otros formatos, y el reproductor dice «formato erróneo». Esta página los convierte a su formato.',
    'faq.how.q': '¿Cómo paso el video al reproductor?',
    'faq.private.q': '¿Mi video se sube a internet?',
    'faq.private.a': 'No. La conversión ocurre en tu propio equipo. Tu video no se envía a ningún lado.',
    'faq.error.q': 'El reproductor dice «formato erróneo»',
    'faq.error.a': 'Revisa que elegiste el archivo que termina en .amv, no el video original. Si aun así no se ve, convierte el video otra vez desde aquí.',
    'faq.missing.q': 'No aparece el video en el reproductor',
    'faq.missing.a': 'Si se desconecta el cable sin expulsar los discos, el reproductor puede no ver los archivos nuevos. Vuelve a conectarlo y revisa que el video esté en la tarjeta («Untitled 1»), dentro de la carpeta «Videos».',
    'faq.bt.q': 'El video no se reproduce con audífonos Bluetooth',
    'faq.bt.a': 'Así funciona este reproductor: para ver videos hay que apagar el Bluetooth. Usa audífonos con cable o la bocina del aparato.',
    'faq.what.q': '¿Qué videos puedo convertir?',
    'faq.what.a': 'Casi cualquiera: del celular, de WhatsApp, de internet o de una cámara (MP4, MOV, AVI, WMV, MKV, MPG y muchos más). Puedes elegir varios a la vez.',

    'footer.love': 'Hecho con cariño, para la familia.',
    'device.videoTile': 'Vídeo',
    'a11y.progress': 'Progreso de la conversión',
    'a11y.player': 'Ilustración del reproductor ZUSZOX mostrando tu video',
    'a11y.announce.done': '{title}: listo para guardar.',
    'a11y.announce.error': '{title}: {error}',
    'a11y.announce.added': 'Se agregó {title}.',
  },

  en: {
    'doc.title': 'Videos for the player',
    'lang.switch': 'Español',
    'lang.switchLabel': 'View this page in Spanish',

    'hero.title': 'Take your videos to the player',
    'hero.lede': 'Choose a video and we’ll get it ready for your ZUSZOX player.',
    'hero.choose': 'Choose video',
    'hero.drop': 'or drag it here',
    'hero.dropActive': 'Drop it here',
    'hero.privacy.computer': 'Your video isn’t uploaded anywhere: it’s converted right here, on your computer.',
    'hero.privacy.phone': 'Your video isn’t uploaded anywhere: it’s converted right here, on your phone.',
    'hero.privacy.tablet': 'Your video isn’t uploaded anywhere: it’s converted right here, on your tablet.',
    'steps.1': 'Choose the video',
    'steps.2': 'Wait while it converts',
    'steps.3': 'Copy it to the player',

    'engine.preparing': 'Getting the converter ready…',
    'engine.preparingPct': 'Getting the converter ready… {pct}',
    'engine.firstTime': 'This only takes a while the first time.',
    'engine.offline': 'No internet connection. We’ll try again as soon as it’s back.',

    'item.checking': 'Checking the video…',
    'item.waiting': 'Waiting',
    'item.converting': 'Converting…',
    'item.convertingPct': 'Converting… {pct}',
    'item.retrying': 'One moment, trying another way…',
    'item.eta.calculating': 'Working out how long it’ll take…',
    'item.eta.lessThanMinute': 'Less than a minute left',
    'item.eta.minutes': 'About {n} minutes left',
    'item.eta.oneMinute': 'About a minute left',
    'item.eta.hours': 'About {h} h {m} min left',
    'item.keepOpen': 'You can do something else meanwhile. Just don’t close this page.',
    'item.keepVisible': 'This video needs this page to stay in view while it converts.',
    'item.cancel': 'Cancel',
    'item.remove': 'Remove',

    'fit.label': 'Picture',
    'fit.fit': 'Whole picture',
    'fit.fitHint': 'Shows everything, with black bars',
    'fit.fill': 'Fill screen',
    'fit.fillHint': 'Fills the screen and trims the edges',

    'done.title': 'Done!',
    'done.lede': 'You can copy it to the player now.',
    'done.verified': 'Checked: it’s in the format your player opens.',
    'done.tooBig': 'Heads up: it’s over 4 GB, and the player’s card can’t take files that big. If you can, cut the video into parts before converting it.',
    'done.saveToPlayer': 'Save to the player',
    'done.saveToComputer': 'Save to this computer',
    'done.save': 'Save video',
    'done.saveAll': 'Save all {n} videos',
    'done.share': 'Share',
    'done.another': 'Convert another video',
    'done.play': 'See how it looks',
    'done.pause': 'Pause',
    'done.playLabel': 'Play the preview',

    'saved.downloads': 'Saved to your Downloads folder.',
    'saved.player': 'Saved to the player, in {where}.',

    'player.pickTitle': 'Choose the player’s card',
    'player.pickHelp.mac': 'Connect the player with its cable. A window will open: on the left choose “Untitled 1” (the card), open the “Videos” folder and click “Select”.',
    'player.pickHelp.windows': 'Connect the player with its cable. A window will open: choose the player drive that is the card (the larger one), open its “Videos” folder and click “Select Folder”.',
    'player.pickHelp.other': 'Connect the player with its cable. A window will open: choose the player’s card (the larger disk), open its “Videos” folder and confirm.',
    'player.pick': 'Choose the player',
    'player.internalWarning': 'That looks like the player’s internal memory. The card is better: the “Untitled 1” disk, the larger one.',
    'player.useAnyway': 'Save here anyway',
    'player.chooseOther': 'Choose another disk',
    'player.permission': 'Then the browser will ask permission to save there: accept it.',

    'copy.title': 'Now copy it to the player',
    'copy.titleDone': 'Before you unplug it',
    'copy.connect': 'Connect the player to the computer with its cable.',
    'copy.open.mac': 'In Finder’s left sidebar, two disks appear: “Untitled” and “Untitled 1”. Open “Untitled 1”: that’s the memory card. Then open the “Videos” folder.',
    'copy.open.windows': 'Open “This PC”. You’ll see two new drives: open the larger one (the memory card), then the “Videos” folder.',
    'copy.open.other': 'Open the player’s memory-card disk (the larger one), then the “Videos” folder.',
    'copy.drag': 'Drag the video “{name}” there from your Downloads folder.',
    'copy.eject.mac': 'Before unplugging the cable, eject both disks: click ⏏ next to each one.',
    'copy.eject.windows': 'Before unplugging the cable, eject both drives: right-click each one and choose “Eject”.',
    'copy.eject.other': 'Before unplugging the cable, eject the player’s disks.',
    'copy.watch': 'On the player, open “Vídeo” (“Video” if it’s in English) and choose “{title}”. Bluetooth has to be off to watch videos.',
    'copy.phone': 'You need a computer to copy it to the player. Save the video and send it to yourself, or open this page on the computer.',

    'err.title.empty': 'This file is empty',
    'err.body.empty': 'There’s nothing inside. It may not have finished copying or downloading.',
    'err.title.image': 'This is a photo, not a video',
    'err.body.image': 'Choose a video file.',
    'err.title.document': 'This file isn’t a video',
    'err.body.document': 'It looks like a document. Choose a video file.',
    'err.title.archive': 'This is a compressed file',
    'err.body.archive': 'Open it first (double-click), then choose the video inside.',
    'err.title.not-media': 'This file isn’t a video',
    'err.body.not-media': 'We found no picture or sound in it. Choose a video file.',
    'err.title.already-amv': 'This video is already ready',
    'err.body.already-amv': 'It’s already in the player’s format (.amv). No need to convert it: copy it as it is.',
    'err.title.unreadable': 'We couldn’t read this video',
    'err.body.unreadable': 'It may be damaged or in a very unusual format. Try another copy of the same video.',
    'err.title.incomplete': 'This video is incomplete',
    'err.body.incomplete': 'It looks like it didn’t finish downloading or copying. Download it again and try once more.',
    'err.title.undecodable': 'This video is in a format we can’t convert yet',
    'err.body.undecodable': 'If you downloaded it, try downloading it again as MP4 (for example, 720p).',
    'err.title.no-frames': 'This video has no picture',
    'err.body.no-frames': 'We didn’t find any picture to convert.',
    'err.title.out-of-memory': 'Your device ran out of memory',
    'err.body.out-of-memory': 'Close other windows or tabs and try again.',
    'err.title.engine-unavailable': 'The converter couldn’t get ready',
    'err.body.engine-unavailable': 'Check your internet connection and try again.',
    'err.title.browser-unsupported': 'This browser is too old',
    'err.body.browser-unsupported': 'Open this page in an up-to-date Chrome, Edge, Firefox or Safari.',
    'err.title.save-failed': 'It couldn’t be saved',
    'err.body.save-failed': 'Check that the player is still connected and has space, then try again.',
    'err.title.internal': 'Something went wrong while converting',
    'err.body.internal': 'Try again. If it keeps happening, copy the details and send them to whoever helps you.',
    'err.retry': 'Try again',
    'err.other': 'Choose another video',
    'err.details': 'Technical details',
    'err.copy': 'Copy details',
    'err.copied': 'Copied',

    'leave.warning': 'A video is being converted. If you leave, it’ll be lost.',
    'tab.done': '✓ Done — {title}',
    'tab.progress': '{pct} · Converting',

    'list.title': 'Your videos',
    'list.summary': '{done} of {total} ready',

    'faq.title': 'Questions',
    'faq.why.q': 'Why do videos need converting?',
    'faq.why.a': 'Your player only opens videos in its own format (AMV, 320 × 240). Videos from phones or the internet come in other formats, and the player says “format error”. This page converts them to its format.',
    'faq.how.q': 'How do I copy the video to the player?',
    'faq.private.q': 'Is my video uploaded to the internet?',
    'faq.private.a': 'No. The conversion happens on your own device. Your video isn’t sent anywhere.',
    'faq.error.q': 'The player says “format error”',
    'faq.error.a': 'Make sure you chose the file that ends in .amv, not the original video. If it still won’t play, convert the video again here.',
    'faq.missing.q': 'The video doesn’t show up on the player',
    'faq.missing.a': 'If the cable is unplugged without ejecting the disks, the player may not see new files. Plug it in again and check that the video is on the card (“Untitled 1”), inside the “Videos” folder.',
    'faq.bt.q': 'The video won’t play with Bluetooth earphones',
    'faq.bt.a': 'That’s how this player works: Bluetooth has to be off to watch videos. Use wired earphones or the player’s speaker.',
    'faq.what.q': 'Which videos can I convert?',
    'faq.what.a': 'Almost any: from a phone, WhatsApp, the internet or a camera (MP4, MOV, AVI, WMV, MKV, MPG and many more). You can choose several at once.',

    'footer.love': 'Made with love, for the family.',
    'device.videoTile': 'Video',
    'a11y.progress': 'Conversion progress',
    'a11y.player': 'Illustration of the ZUSZOX player showing your video',
    'a11y.announce.done': '{title}: ready to save.',
    'a11y.announce.error': '{title}: {error}',
    'a11y.announce.added': 'Added {title}.',
  },
};

export const LANGS = Object.keys(STRINGS);

let current = 'es';

export function setLang(lang) {
  current = STRINGS[lang] ? lang : 'es';
  return current;
}

export function getLang() {
  return current;
}

/** Translate a key, filling {placeholders}. Falls back to Spanish, then the key. */
export function t(key, params = {}) {
  const table = STRINGS[current] || STRINGS.es;
  let s = table[key] ?? STRINGS.es[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? String(params[name]) : m));
}

/** Language from ?lang=, then the saved choice; Spanish otherwise. */
export function initialLang(search = '', saved = null) {
  const q = new URLSearchParams(search).get('lang');
  if (q && STRINGS[q]) return q;
  if (saved && STRINGS[saved]) return saved;
  return 'es';
}

/** "37%": Mexico, like English, writes no space before the sign. */
export function pct(fraction) {
  const n = Math.max(0, Math.min(100, Math.floor((Number(fraction) || 0) * 100)));
  return `${n}%`;
}
