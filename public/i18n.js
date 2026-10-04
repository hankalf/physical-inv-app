/* English and Spanish on the gun.
 *
 * The app is written in English, and every word it puts on the screen passes
 * through here on the way: a fixed phrase is looked up, a sentence with a pallet
 * or a bin in it is matched by its shape, and the rest - a pallet ID, a bin
 * code, a name - is left exactly as it is. So the counting logic never has to
 * know which language it is in, and a message added later shows in English
 * rather than not at all.
 *
 * What is stored never changes language: a count line, a reason, an SOS go to
 * the server in English, so the office reads one language whoever counted.
 *
 * Words chosen for a US cold store: "tarima" for a pallet, "ubicación" for a
 * bin, "número de empleado" for a clock-in number.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------- fixed phrases */
  const ES = {
    // header and bars
    'Inventory Count': 'Conteo de inventario',
    'online': 'en línea', 'OFFLINE': 'SIN SEÑAL', 'PRACTICE': 'PRÁCTICA', 'TRIAL RUN': 'PRUEBA',
    'Update ready': 'Actualización lista',
    'It will load by itself when you finish this pallet — or tap here to take it now.':
      'Se cargará sola cuando termines esta tarima — o toca aquí para cargarla ya.',
    'Tap here to scan': 'Toca aquí para escanear',
    'The keyboard is not pointed at this app — a scan would go to the browser instead.':
      'El teclado no está en esta app — un escaneo iría al navegador.',

    // device set-up
    'Set up this scanner': 'Configurar este escáner',
    'A supervisor registers this scanner in the dashboard; you open its link here once and add it to the home screen. That link is what signs the scanner in — without it the server will not accept counts.':
      'Un supervisor registra este escáner en el panel; abres su enlace aquí una vez y lo agregas a la pantalla de inicio. Ese enlace es lo que conecta el escáner — sin él el servidor no acepta conteos.',
    'Scanner ID': 'ID del escáner', 'Save': 'Guardar', 'Enter a scanner ID': 'Escribe un ID de escáner',

    // sign-on
    'What are you doing?': '¿Qué vas a hacer?',
    'Full count': 'Conteo completo', 'Cycle count': 'Conteo cíclico',
    'Count session': 'Sesión de conteo', 'Which one': '¿Cuál?', 'Loading…': 'Cargando…',
    'Team number': 'Número de equipo',
    'Clock In Numbers — scan them, then Enter': 'Números de empleado — escanéalos y luego Enter',
    'Scan a badge': 'Escanea un gafete', 'Add': 'Agregar',
    'Type it instead — show the keyboard': 'Escribirlo — mostrar el teclado',
    'Everyone on the crew — tap a number to remove it.': 'Todos en el equipo — toca un número para quitarlo.',
    'Sign on & load list': 'Entrar y cargar la lista',
    'Downloading list…': 'Descargando la lista…',
    'Refresh sessions': 'Actualizar sesiones',
    'Running in the browser': 'Abierto en el navegador',
    'Install on this scanner': 'Instalar en este escáner',
    'Hide the browser bar for this shift': 'Ocultar la barra del navegador este turno',
    'Change scanner ID': 'Cambiar ID del escáner',
    'No list cached on this scanner yet.': 'Todavía no hay lista guardada en este escáner.',
    'Enter your team number': 'Escribe tu número de equipo',
    'Add at least one clock in number': 'Agrega al menos un número de empleado',
    'Pick a count session': 'Elige una sesión de conteo',
    'Server unreachable': 'No se puede conectar al servidor',
    'Cannot reach the server': 'No se puede conectar al servidor',
    'Using the list cached on this scanner. Counts will queue until Wi-Fi returns.':
      'Usando la lista guardada en este escáner. Los conteos esperarán hasta que vuelva el Wi-Fi.',
    'This session has no bin list yet': 'Esta sesión aún no tiene lista de ubicaciones',
    'A supervisor needs to upload it before counting.': 'Un supervisor tiene que subirla antes de contar.',
    'Offline and no list cached for this session': 'Sin señal y sin lista guardada para esta sesión',
    'Connect to Wi-Fi once to download it.': 'Conéctate al Wi-Fi una vez para descargarla.',
    'Signed on locally only': 'Entraste solo en este escáner',
    'Could not sign on': 'No se pudo entrar',
    'No open sessions on the server': 'No hay sesiones abiertas en el servidor',
    'No full count running': 'No hay conteo completo en curso',
    'No cycle count running': 'No hay conteo cíclico en curso',
    'English': 'English', 'Español': 'Español',

    // assignment
    'Got it': 'Entendido',
    'Start counting': 'Empezar a contar',
    'Aisle complete — next aisle': 'Pasillo terminado — siguiente pasillo',
    'Second counts available': 'Segundos conteos disponibles',
    'bins to go back to — the first count didn\'t agree with the inventory report, or a supervisor asked.':
      'ubicaciones para volver a contar — el primer conteo no coincidió con el reporte, o un supervisor lo pidió.',
    'bins on today\'s list — scan every pallet in each, or mark it empty.':
      'ubicaciones en la lista de hoy — escanea cada tarima en cada una, o márcala vacía.',
    'bins on your list — scan every pallet in each, or mark it empty.':
      'ubicaciones en tu lista — escanea cada tarima en cada una, o márcala vacía.',
    'Nothing on your list right now. Tap Refresh once a supervisor has generated today\'s bins.':
      'Nada en tu lista por ahora. Toca Actualizar cuando un supervisor genere las ubicaciones de hoy.',
    'Bins to count': 'Ubicaciones por contar',
    'Start second counts': 'Empezar segundos conteos',
    'Start counting the list': 'Empezar a contar la lista',
    'Refresh': 'Actualizar', 'History': 'Historial',
    'Sign off this scanner': 'Salir de este escáner',
    'My aisle': 'Mi pasillo', 'My list': 'Mi lista',
    'Count without an assignment': 'Contar sin asignación',
    'Count anyway (flagged)': 'Contar de todos modos (marcado)',
    'No plan': 'Sin plan',
    'No assignment loaded for this team. Refresh once Wi-Fi is back, or count freely.':
      'No hay asignación para este equipo. Actualiza cuando vuelva el Wi-Fi, o cuenta libremente.',
    'All done': 'Todo listo',
    'No aisles assigned to this team yet. Check with a supervisor.':
      'Todavía no hay pasillos asignados a este equipo. Pregunta a un supervisor.',
    'Waiting for a supervisor to release this aisle.': 'Esperando a que un supervisor libere este pasillo.',
    'Need Wi-Fi to complete an aisle': 'Se necesita Wi-Fi para terminar un pasillo',
    'The next aisle is released by the server.': 'El servidor es el que libera el siguiente pasillo.',
    'Could not complete aisle': 'No se pudo terminar el pasillo',
    'Could not refresh': 'No se pudo actualizar',
    'That bin was taken by another team': 'Otro equipo tomó esa ubicación',
    'All second counts done': 'Todos los segundos conteos terminados',
    'Nothing more to go back to right now.': 'No hay nada más para volver a contar por ahora.',
    'Check your equipment': 'Revisa tu equipo de trabajo',
    'Check the crew': 'Revisa el equipo',
    'On foot': 'A pie', 'on foot only': 'solo a pie',
    'last aisle in your plan': 'último pasillo de tu plan',

    // counting
    'Scan PALLET ID': 'Escanea la TARIMA', 'Enter QUANTITY': 'Escribe la CANTIDAD',
    'Scan BIN LOCATION': 'Escanea la UBICACIÓN', 'Scan LOT CODE': 'Escanea el LOTE',
    'Enter EXPIRY (YYYY-MM-DD)': 'Escribe el VENCIMIENTO (AAAA-MM-DD)',
    'Comments (optional)': 'Comentarios (opcional)',
    'EMPTY bin — scan its LOCATION': 'Ubicación VACÍA — escanea la UBICACIÓN',
    'Keyboard': 'Teclado', 'Keyboard on': 'Teclado activo', 'Back': 'Atrás', 'Skip': 'Saltar',
    'Bin is EMPTY — scan the bin': 'Ubicación VACÍA — escanea la ubicación',
    'Several empty bins in a row': 'Varias ubicaciones vacías seguidas',
    'Second label on the same pallet': 'Segunda etiqueta en la misma tarima',
    'Label will not scan': 'La etiqueta no escanea',
    'Bin label will not scan': 'La etiqueta de la ubicación no escanea',
    'I can read it — let me type it': 'La puedo leer — la escribo',
    'Nothing readable on it': 'No se puede leer nada',
    'No readable bin label': 'La ubicación no tiene etiqueta legible',
    'Bin done — nothing more here': 'Ubicación terminada — no hay más aquí',
    'Leave for another team': 'Dejarla para otro equipo',
    'SOS — I need help': 'SOS — necesito ayuda',
    'Take your time — tap Skip or press Enter when done': 'Con calma — toca Saltar o Enter al terminar',
    'Still in this bin': 'Sigues en esta ubicación', 'Next bin': 'Siguiente ubicación',
    'Nothing more here →': 'No hay más aquí →',
    'Your aisle': 'Tu pasillo', 'Pallet': 'Tarima', 'Qty': 'Cant.', 'Bin': 'Ubicación', 'Scanned': 'Escaneado',
    'Now enter what you count': 'Ahora escribe lo que cuentas',
    'Not in the pallet list': 'No está en la lista de tarimas',
    'That is a link, not a pallet': 'Eso es un enlace, no una tarima',
    'Rescan, or ask a supervisor.': 'Vuelve a escanear, o pregunta a un supervisor.',
    'Type a number. If you meant to scan something, press Back first.':
      'Escribe un número. Si querías escanear algo, primero toca Atrás.',
    'That is unusually large. Enter it again to accept, or type the correct number.':
      'Es una cantidad muy grande. Escríbela otra vez para aceptarla, o escribe la correcta.',
    'That is not a date': 'Eso no es una fecha',
    'Use YYYY-MM-DD, or tap Skip if the pallet has none.': 'Usa AAAA-MM-DD, o toca Saltar si la tarima no tiene.',
    'That date has passed — flag it to a supervisor.': 'Esa fecha ya pasó — avisa a un supervisor.',
    'No lot recorded': 'Sin lote', 'No expiry recorded': 'Sin vencimiento', 'Matches the report.': 'Coincide con el reporte.',
    'Count the pallet first': 'Primero cuenta la tarima',
    'Scan the pallet, then its second label.': 'Escanea la tarima, luego su segunda etiqueta.',
    'That is the same label': 'Es la misma etiqueta',
    'That tag belongs to another pallet — tell a supervisor.': 'Esa etiqueta es de otra tarima — avisa a un supervisor.',
    'Recorded with no quantity, so nothing is counted twice.': 'Registrada sin cantidad, para no contar nada dos veces.',
    'Can you read the number on it? Type it if you can — it is still that pallet.':
      '¿Puedes leer el número? Escríbelo si puedes — sigue siendo esa tarima.',
    'Type the bin code': 'Escribe el código de la ubicación', 'Type the pallet ID': 'Escribe el número de la tarima',
    'The line will be flagged so the label gets replaced.': 'La línea queda marcada para que se cambie la etiqueta.',
    'Counting it as a pallet with no label': 'Se cuenta como tarima sin etiqueta',
    'Carry on as normal. It will be named after its bin, and a supervisor gets that bin on the relabel list.':
      'Sigue normal. Tomará el nombre de su ubicación, y un supervisor la tendrá en la lista para re-etiquetar.',
    'Empty bin': 'Ubicación vacía', 'Scan the location of the empty bin.': 'Escanea la ubicación vacía.',
    'flagged': 'marcado', 'empty': 'vacía', 'synced': 'enviado', 'queued': 'en espera', '2nd count': '2º conteo',

    // a run of empty bins
    'Scan the FIRST empty bin': 'Escanea la PRIMERA ubicación vacía',
    'Scan the LAST empty bin': 'Escanea la ÚLTIMA ubicación vacía',
    'Untick any that are NOT empty': 'Desmarca las que NO estén vacías',
    'already counted': 'ya contada',
    'Mark 1 bin EMPTY': 'Marcar 1 ubicación VACÍA',
    'Mark bins EMPTY': 'Marcar ubicaciones VACÍAS',
    'Cancel — back to counting': 'Cancelar — volver a contar',
    'Both bins have to be in the same aisle': 'Las dos ubicaciones tienen que estar en el mismo pasillo',
    'Scan the rack label of a bin in this count.': 'Escanea la etiqueta del rack de una ubicación de este conteo.',
    'That is a long run — check the first and last bin are right.': 'Son muchas — revisa que la primera y la última estén bien.',
    'Could not save': 'No se pudo guardar',

    // override
    'Check this': 'Revisa esto',
    'Pallet not on the list': 'La tarima no está en la lista',
    'Count it anyway?': '¿Contarla de todos modos?',
    'YES': 'SÍ', 'NO': 'NO',
    'Counted - a supervisor will add it to the system': 'Contada — un supervisor la agregará al sistema',
    'Reason (required to continue)': 'Motivo (obligatorio para seguir)',
    'Choose a reason…': 'Elige un motivo…', 'Other': 'Otro',
    'Note (optional)': 'Nota (opcional)', 'Free text': 'Texto libre',
    'Accept and continue': 'Aceptar y seguir',
    'It is a second label on the last pallet': 'Es una segunda etiqueta de la última tarima',
    'Cancel — rescan': 'Cancelar — volver a escanear',
    'Pallet already counted': 'Tarima ya contada',
    'Bin not on the list': 'La ubicación no está en la lista',
    'Not your level': 'No es tu nivel', 'Not your aisle': 'No es tu pasillo',
    'Unknown pallet accepted': 'Tarima desconocida aceptada',

    // history
    'Recent counts': 'Conteos recientes',
    'Most recent 50 lines from this scanner. Void removes a line from the totals.':
      'Las últimas 50 líneas de este escáner. Anular quita una línea de los totales.',
    'Nothing counted on this scanner yet.': 'Todavía no hay nada contado en este escáner.',
    'Void this line': 'Anular esta línea',

    // SOS
    'What is wrong?': '¿Qué pasa?',
    'Anything else (optional)': 'Algo más (opcional)', 'Tap to type': 'Toca para escribir',
    'Back to counting': 'Volver a contar', 'Back to Front2Back': 'Volver a Front2Back', 'Back to Not in Location': 'Volver a Not in Location',
    'Sending…': 'Enviando…',
    'Sent — a supervisor has been told': 'Enviado — ya se avisó a un supervisor',
    'You can carry on counting; the bar at the top says when somebody has seen it.':
      'Puedes seguir contando; la barra de arriba dirá cuando alguien lo vea.',
    'No signal — this has NOT been sent': 'Sin señal — esto NO se ha enviado',
    'It will go the moment there is signal. If it cannot wait, walk to where you have signal or go and find a supervisor.':
      'Se enviará en cuanto haya señal. Si no puede esperar, camina a donde haya señal o busca a un supervisor.',
    'SOS waiting for signal': 'SOS esperando señal', 'SOS sent': 'SOS enviado',
    'Update did not take': 'La actualización no se cargó',

    // the shipped reasons; a site's own words are shown as written
    'Injury — someone needs help now': 'Lesión — alguien necesita ayuda ya',
    'Equipment broke down — lift truck, reach truck, jack': 'Se descompuso el equipo — montacargas, reach, patín',
    'Need a supervisor': 'Necesito un supervisor',
    'Someone is stuck or shut in': 'Alguien está atrapado o encerrado',
    'Racking or a pallet looks unsafe': 'El rack o una tarima se ve inseguro',
    'Forklift or lift truck problem': 'Problema con el montacargas',
    'Spill, leak or damaged stock': 'Derrame, fuga o producto dañado',
    'Cannot reach the bins — blocked': 'No se llega a las ubicaciones — bloqueado',
    'Scanner or app problem': 'Problema con el escáner o la app',
    'Damaged': 'Dañado', 'Partial pallet': 'Tarima parcial', 'Mixed pallet': 'Tarima mixta',
    'Label unreadable': 'Etiqueta ilegible', 'Needs recount': 'Necesita reconteo',
    'Blocked / could not reach': 'Bloqueado / no se alcanzó',
    'New receipt, not on the report': 'Recibo nuevo, no está en el reporte',
    'Relabelled': 'Re-etiquetada', 'Hand-written ID': 'Número escrito a mano',
    'Supervisor said to count it': 'El supervisor dijo que se contara',

    'Type a note or tap one below': 'Escribe una nota o toca una abajo',
    'e.g. 2027-03-15': 'p. ej. 2027-03-15', 'e.g. 3': 'p. ej. 3', 'e.g. SCANNER-04': 'p. ej. SCANNER-04',
    'Team': 'Equipo', 'Aisle': 'Pasillo', 'Last bin': 'Última ubicación', 'Scanner': 'Escáner',
    'Scans can land in the address bar. Install it — Chrome menu →': 'Los escaneos pueden caer en la barra de direcciones. Instálala — menú de Chrome →',
    'Add to Home screen': 'Agregar a la pantalla de inicio',
    ', or the button below — then open it from the home-screen icon.': ', o el botón de abajo — luego ábrela desde el ícono.',
    'This scanner reloaded and is still on the old version. Tell a supervisor.': 'Este escáner se recargó y sigue con la versión anterior. Avisa a un supervisor.',
    'marked empty as part of a run': 'marcada vacía en grupo',
    'The trial run was cleared': 'Se borró la prueba',
    'This pallet has another label': 'Esta tarima tiene otra etiqueta', 'Another label on this pallet': 'Otra etiqueta en esta tarima',
    'That label is already read': 'Esa etiqueta ya se leyó',
    'Scan it. It is recorded with no quantity of its own. Tap Back to cancel.': 'Escanéala. Se registra sin cantidad propia. Toca Atrás para cancelar.',
    'Report a problem — damage, blocked bin': 'Reportar un problema — daño, ubicación bloqueada',
    'What did you find?': '¿Qué encontraste?', 'What is wrong': 'Qué está mal', 'On the fix list': 'En la lista de arreglos',
    'Damaged pallet': 'Tarima dañada', 'Damaged rack or bin': 'Rack o ubicación dañada', 'Damaged product': 'Producto dañado',
    'Bin blocked — come back later': 'Ubicación bloqueada — volver después', 'Something else': 'Otra cosa',
    'Broken boards': 'Tablas rotas', 'Leaning or unstable': 'Inclinada o inestable', 'Wrap torn or open': 'Emplaye roto o abierto', 'Crushed cases': 'Cajas aplastadas',
    'Beam bent': 'Viga doblada', 'Upright hit': 'Poste golpeado', 'Beam or clip missing': 'Falta viga o seguro', 'Decking broken': 'Piso del rack roto', 'Ice build-up': 'Acumulación de hielo',
    'Leaking': 'Con fuga', 'Thawed or soft': 'Descongelado o blando', 'Crushed': 'Aplastado', 'Open cases': 'Cajas abiertas',
    'Trailer in the way': 'Un tráiler estorba', 'Forklift or equipment in the aisle': 'Montacargas o equipo en el pasillo', 'Spill on the floor': 'Derrame en el piso', 'Locked or caged': 'Cerrado o enjaulado',
    'Wrong product on the pallet': 'Producto equivocado en la tarima', 'Pallet on the floor, not in a bin': 'Tarima en el piso, no en ubicación', 'Light out': 'Luz apagada', 'Needs a supervisor to look': 'Que lo revise un supervisor',
    'Your clock-in number — scan it, then Enter': 'Tu número de empleado — escanéalo y luego Enter',
    'Just you. Scan your badge and sign on.': 'Solo tú. Escanea tu gafete y entra.',
    'Scan your clock-in number': 'Escanea tu número de empleado',
    'Front2Back': 'Front2Back', 'Not in Location': 'Not in Location',
    'Count it here as normal; the office is told where it turned up.': 'Cuéntala aquí normal; la oficina sabrá dónde apareció.', 'MOVE THIS PALLET': 'MUEVE ESTA TARIMA', 'MOVE PALLETS': 'MOVER TARIMAS',
    'Scan the PALLET': 'Escanea la TARIMA', 'Scan the BIN it went into': 'Escanea la UBICACIÓN donde quedó',
    'Cannot move it': 'No se puede mover', 'Aisles': 'Pasillos',
    'pallets to move back — pick an aisle': 'tarimas por mover atrás — elige un pasillo',
    'Nothing left to move. Refresh to check again, or sign off.': 'No queda nada por mover. Actualiza para revisar, o sal.',
    'That is the front bin it came from': 'Esa es la ubicación de enfrente de donde salió',
    'Pallet is not there': 'La tarima no está', 'Bin behind is not empty': 'La ubicación de atrás no está vacía',
    'Cannot reach it': 'No se alcanza', 'Pallet is damaged': 'La tarima está dañada',
    'No pallets to move running': 'No hay tarimas por mover',
    'Put the pallet in the bin behind its front position. If it cannot go there, tap Cannot move it.': 'Pon la tarima en la ubicación detrás de su posición de enfrente. Si no cabe ahí, toca No se puede mover.',
    'This is the real count now — everything starts fresh.': 'Ahora es el conteo real — todo empieza de nuevo.',
    'Not on the list - counted anyway': 'No está en la lista — contada de todos modos',
    'This scanner link was removed by a supervisor. Ask for a new one.': 'Un supervisor quitó el enlace de este escáner. Pide uno nuevo.',
    'Cannot reach the server to check this scanner link. Connect to Wi-Fi and reload.': 'No se puede conectar para revisar el enlace del escáner. Conéctate al Wi-Fi y recarga.',
    'Scanner link problem': 'Problema con el enlace del escáner',
    'This scanner is not signed in': 'Este escáner no está conectado',

    // what the server can say back
    'session is closed': 'la sesión está cerrada',
    'session not found': 'no se encontró la sesión',
  };

  /* ------------------------------------------------- sentences with codes */
  const T = (s) => tr(s);
  const PATTERNS = [
    [/^Step (\d+) of (\d+)$/, (m) => `Paso ${m[1]} de ${m[2]}`],
    [/^Counted (.+)$/, (m) => `Contada ${m[1]}`],
    [/^Pallet (.+)$/, (m) => `Tarima ${m[1]}`],
    [/^Qty (.+)$/, (m) => `Cant. ${m[1]}`],
    [/^Bin (\S+) recorded as EMPTY$/, (m) => `Ubicación ${m[1]} registrada VACÍA`],
    [/^(\d+) bins? recorded as EMPTY$/, (m) => `${m[1]} ${m[1] === '1' ? 'ubicación registrada VACÍA' : 'ubicaciones registradas VACÍAS'}`],
    [/^Mark (\d+) bins EMPTY$/, (m) => `Marcar ${m[1]} ubicaciones VACÍAS`],
    [/^(\S+) to (\S+)$/, (m) => `${m[1]} a ${m[2]}`],
    [/^(\d+) bins$/, (m) => `${m[1]} ubicaciones`],
    [/^From (\S+) — (.*)$/, (m) => `Desde ${m[1]} — ${T(m[2])}`],
    [/^Bin (\S+)$/, (m) => `Ubicación ${m[1]}`],
    [/^Lot (.+)$/, (m) => `Lote ${m[1]}`],
    [/^Expires (.+)$/, (m) => `Vence ${m[1]}`],
    [/^Confirm quantity (.+)$/, (m) => `Confirma la cantidad ${m[1]}`],
    [/^"(.*)" is not a quantity$/, (m) => `"${m[1]}" no es una cantidad`],
    [/^(\S+) is not on the pallet list$/, (m) => `${m[1]} no está en la lista de tarimas`],
    [/^(\S+) is not on the bin list$/, (m) => `${m[1]} no está en la lista de ubicaciones`],
    [/^(\S+) is not in the uploaded pallet file\.$/, (m) => `${m[1]} no está en el archivo de tarimas.`],
    [/^(\S+) is not in the uploaded bin list\.$/, (m) => `${m[1]} no está en la lista de ubicaciones.`],
    [/^(\S+) was already counted in bin (\S+) on this scanner\.$/, (m) => `${m[1]} ya se contó en la ubicación ${m[2]} en este escáner.`],
    [/^(\S+) was already counted in bin (\S+) by team (\S+)\.$/, (m) => `${m[1]} ya la contó el equipo ${m[3]} en la ubicación ${m[2]}.`],
    [/^System expected this pallet in (\S+), not (\S+)$/, (m) => `El sistema esperaba esta tarima en ${m[1]}, no en ${m[2]}`],
    [/^Recorded against (\S+)$/, (m) => `Registrado en ${m[1]}`],
    [/^The report says this pallet is lot (.+)\.$/, (m) => `El reporte dice que esta tarima es del lote ${m[1]}.`],
    [/^This second count is for bin (\S+)$/, (m) => `Este segundo conteo es para la ubicación ${m[1]}`],
    [/^You scanned (\S+)\. Scan (\S+), or tap Bin done\.$/, (m) => `Escaneaste ${m[1]}. Escanea ${m[2]}, o toca Ubicación terminada.`],
    [/^Bin (\S+) is on level (\S+)\. Your team is assigned (.+) of this aisle\.$/, (m) => `La ubicación ${m[1]} está en el nivel ${m[2]}. A tu equipo le tocan ${T(m[3])} de este pasillo.`],
    [/^It is a second label on (\S+)$/, (m) => `Es una segunda etiqueta de ${m[1]}`],
    [/^Scan the OTHER label on (\S+)$/, (m) => `Escanea la OTRA etiqueta de ${m[1]}`],
    [/^Second label on (\S+)$/, (m) => `Segunda etiqueta de ${m[1]}`],
    [/^Scan the other tag on (\S+), or tap Back\.$/, (m) => `Escanea la otra etiqueta de ${m[1]}, o toca Atrás.`],
    [/^(\S+) was counted in (\S+)$/, (m) => `${m[1]} se contó en ${m[2]}`],
    [/^(\S+) is the same pallet as (\S+)$/, (m) => `${m[1]} es la misma tarima que ${m[2]}`],
    [/^It is (\S+)$/, (m) => `Es ${m[1]}`],
    [/^Moving on to the next bin in (\d+)…$/, (m) => `Pasando a la siguiente ubicación en ${m[1]}…`],
    [/^(\d+) of (\d+) tags$/, (m) => `${m[1]} de ${m[2]} etiquetas`],
    [/^(\d+) tags?$/, (m) => `${m[1]} ${m[1] === '1' ? 'etiqueta' : 'etiquetas'}`],
    [/^(\d+) of (\d+)$/, (m) => `${m[1]} de ${m[2]}`],
    [/^(\d+) queued$/, (m) => `${m[1]} en espera`],
    [/^(\d+) counts? still on this scanner$/, (m) => `${m[1]} ${m[1] === '1' ? 'conteo sigue' : 'conteos siguen'} en este escáner`],
    [/^The oldest is (\d+) minutes old and the server has not taken it yet\. Tell a supervisor before you put this scanner down\.$/,
      (m) => `El más viejo tiene ${m[1]} minutos y el servidor no lo ha recibido. Avisa a un supervisor antes de dejar el escáner.`],
    [/^No signal for (\d+) minutes\. Nothing is lost — walk somewhere with Wi-Fi and they will send themselves\.$/,
      (m) => `Sin señal por ${m[1]} minutos. No se pierde nada — camina a donde haya Wi-Fi y se enviarán solos.`],
    [/^(.+) — (\S+) — empty$/, (m) => `${m[1]} — ${m[2]} — vacía`],
    [/^(\S+) — empty$/, (m) => `${m[1]} — vacía`],
    [/^(.+) has seen your SOS$/, (m) => `${m[1]} vio tu SOS`],
    [/^(.+) — help is coming\.$/, (m) => `${T(m[1])} — ya viene ayuda.`],
    [/^(.+) — waiting for somebody in the office to pick it up\.$/, (m) => `${T(m[1])} — esperando a que alguien en la oficina lo vea.`],
    [/^(.+) — it has not been sent yet\. It will go as soon as there is signal\.$/, (m) => `${T(m[1])} — todavía no se envía. Se enviará en cuanto haya señal.`],
    [/^Team (\S+) — your aisle$/, (m) => `Equipo ${m[1]} — tu pasillo`],
    [/^Team (\S+) — next aisle$/, (m) => `Equipo ${m[1]} — siguiente pasillo`],
    [/^Team (\S+)$/, (m) => `Equipo ${m[1]}`],
    [/^(\d+) of (\d+) bins have a count(.*)$/, (m) => `${m[1]} de ${m[2]} ubicaciones contadas${m[3].replace(/ · next: /, ' · siguiente: ').replace(' · last aisle in your plan', ' · último pasillo de tu plan').replace(/Aisle/g, 'Pasillo')}`],
    [/^Count (.+) \((.+)\)$/, (m) => `Contar ${T(m[1])} (${T(m[2])})`],
    [/^Finished: (.+)\. Check with a supervisor for more\.$/, (m) => `Terminado: ${T(m[1])}. Pregunta a un supervisor si hay más.`],
    [/^Waiting: team (\S+) is still in (.+?)(, which shares racking with (\S+))?\. Refresh when they finish\.$/,
      (m) => `Esperando: el equipo ${m[1]} sigue en ${T(m[2])}${m[3] ? `, que comparte rack con ${m[4]}` : ''}. Actualiza cuando terminen.`],
    [/^(\d+) bin\(s\) in (\S+) have no count\. Empty bins are fine — complete the aisle anyway\?$/,
      (m) => `${m[1]} ubicación(es) en ${m[2]} no tienen conteo. Las vacías están bien — ¿terminar el pasillo de todos modos?`],
    [/^(\d+) line\(s\) have not reached the server yet\. Sign off anyway\?$/,
      (m) => `${m[1]} línea(s) todavía no llegan al servidor. ¿Salir de todos modos?`],
    [/^Signed on: (.+)$/, (m) => `Entraron: ${m[1]}`],
    [/^Not on the crew list: (.+) — check the clock in number, or ask a supervisor to add them\.$/,
      (m) => `No están en la lista: ${m[1]} — revisa el número de empleado, o pide a un supervisor que los agregue.`],
    [/^(.+) \((\S+)\) is on team (\S+) today, not team (\S+)\.$/, (m) => `${m[1]} (${m[2]}) está hoy en el equipo ${m[3]}, no en el ${m[4]}.`],
    [/^Between you: (.+) — reaches (.+)\.$/, (m) => `Entre ustedes: ${T(m[1])} — alcanzan ${T(m[2])}.`],
    [/^(.+) · reaches (.+)$/, (m) => `${T(m[1])} · alcanzan ${T(m[2])}`],
    [/^(CYCLE COUNT|SECOND COUNT) · bin (\S+)$/, (m) => `${m[1] === 'CYCLE COUNT' ? 'CONTEO CÍCLICO' : 'SEGUNDO CONTEO'} · ubicación ${m[2]}`],
    [/^(.*) — (.*)\. Scan every pallet in this bin, then tap Bin done\.$/, (m) => `${T(m[1])} — ${T(m[2])}. Escanea cada tarima de esta ubicación, luego toca Ubicación terminada.`],
    [/^Bin (\S+) second count done$/, (m) => `Segundo conteo de ${m[1]} terminado`],
    [/^Bin (\S+) done$/, (m) => `Ubicación ${m[1]} terminada`],
    [/^Next: bin (\S+)$/, (m) => `Siguiente: ubicación ${m[1]}`],
    [/^Now bin (\S+) — (.*)$/, (m) => `Ahora la ubicación ${m[1]} — ${T(m[2])}`],
    [/^URGENT · (.+)$/, (m) => `URGENTE · ${T(m[1])}`],
    [/^(.+) → every team$/, (m) => `${m[1] === 'the office' ? 'la oficina' : m[1]} → todos los equipos`],
    [/^(.+) → team (\S+)$/, (m) => `${m[1] === 'the office' ? 'la oficina' : m[1]} → equipo ${m[2]}`],
    [/^(.+) Overrides are off for this session\.$/, (m) => `${T(m[1])} Las excepciones están desactivadas en esta sesión.`],
    [/^(.+) Anything already counted is still saved on this scanner and will send once it is authorised again\.$/,
      (m) => `${m[1]} Lo que ya se contó sigue guardado en este escáner y se enviará cuando vuelva a estar autorizado.`],
    [/^Every bin in (\S+) has a count — tap "Aisle complete" when you are happy\.$/, (m) => `Todas las ubicaciones de ${m[1]} tienen conteo — toca "Pasillo terminado" cuando estés seguro.`],
    [/^App build (\S+) on the server — this scanner is (up to date|behind it; an update is waiting)\.$/,
      (m) => `Versión ${m[1]} en el servidor — este escáner ${m[2] === 'up to date' ? 'está al día' : 'está atrasado; hay una actualización esperando'}.`],
    [/^(.+) · (\S+)\. Carry on counting — a supervisor will see it\.$/, (m) => `${T(m[1])} · ${m[2]}. Sigue contando — un supervisor lo verá.`],
    [/^(.+)\. Carry on counting — a supervisor will see it\.$/, (m) => `${T(m[1])}. Sigue contando — un supervisor lo verá.`],
    [/^(\S+) was on the Not in Location list — found!$/, (m) => `¡${m[1]} estaba en la lista de No en ubicación — apareció!`],
    [/^Last seen in (\S+)\. (.*)$/, (m) => `Vista por última vez en ${m[1]}. ${T(m[2])}`],
    [/^Another label on (\S+)$/, (m) => `Otra etiqueta en ${m[1]}`],
    [/^Scan a different tag on (\S+), or enter the quantity\.$/, (m) => `Escanea otra etiqueta de ${m[1]}, o escribe la cantidad.`],
    [/^(\d+) labels on it\. Scan another, or enter the quantity\.$/, (m) => `${m[1]} etiquetas en ella. Escanea otra, o escribe la cantidad.`],
    [/^That is (\S+) — this move is pallet (\S+)$/, (m) => `Esa es ${m[1]} — este movimiento es la tarima ${m[2]}`],
    [/^It should be in (\S+), the front position\.$/, (m) => `Debería estar en ${m[1]}, la posición de enfrente.`],
    [/^Move it to (\S+) — the bin behind — then scan that bin\.$/, (m) => `Muévela a ${m[1]} — la ubicación de atrás — y escanea esa ubicación.`],
    [/^Scan the bin behind: (\S+)\.$/, (m) => `Escanea la ubicación de atrás: ${m[1]}.`],
    [/^That is (\S+), not (\S+)$/, (m) => `Esa es ${m[1]}, no ${m[2]}`],
    [/^Moved (\S+) to (\S+)$/, (m) => `Movida ${m[1]} a ${m[2]}`],
    [/^Skipped (\S+)$/, (m) => `Saltada ${m[1]}`],
    [/^(\d+) left in this aisle$/, (m) => `${m[1]} quedan en este pasillo`],
    [/^(\d+) to move$/, (m) => `${m[1]} por mover`],
    [/^from (\S+) → to (\S+) \(behind\)$/, (m) => `de ${m[1]} → a ${m[2]} (atrás)`],
    [/^(.+) · (\d+) to move(.*)$/, (m) => `${T(m[1])} · ${m[2]} por mover${m[3].replace(' · level ', ' · nivel ')}`],
    [/^Scanner ID (\S+) was typed on this device \(not registered\)\.$/, (m) => `El ID ${m[1]} se escribió en este equipo (no registrado).`],
    [/^This scanner is registered as (\S+)(.*)\.$/, (m) => `Este escáner está registrado como ${m[1]}${m[2] ? ' (sin señal — usando la identidad guardada)' : ''}.`],
    [/^Cached: session #(\d+), ([\d,]+) bins, ([\d,]+) pallets(.*)$/, (m) => `Guardado: sesión #${m[1]}, ${m[2]} ubicaciones, ${m[3]} tarimas${m[4].replace(' (downloaded ', ' (descargada ')}`],
    [/^(.+) \(cached\)$/, (m) => `${m[1]} (guardada)`],
    [/^(\d+) @ (\S+)(.*)$/, (m) => `${m[1]} @ ${m[2]}${m[3].replace('· flagged', '· marcado')}`],
    [/^(.+) · (synced|queued)(.*)$/, (m) => `${m[1]} · ${m[2] === 'synced' ? 'enviado' : 'en espera'}${m[3].replace(' · 2nd count', ' · 2º conteo').replace(/ · flagged: (.*)$/, (x, why) => ` · marcado: ${T(why)}`).replace('marked empty as part of a run', 'marcada vacía en grupo').replace(/second label on (\S+)/, 'segunda etiqueta de $1')}`],
  ];

  /* the pieces that labels are built from: "Freezer – Aisle F01 · levels A–F" */
  const PIECES = [
    [/\bAisle\b/g, 'Pasillo'], [/\blevels\b/g, 'niveles'], [/\blevel\b/g, 'nivel'], [/\bLevel\b/g, 'Nivel'],
    [/\bPosition\b/g, 'Posición'], [/\bFRONT\b/g, 'FRENTE'], [/\bBACK\b/g, 'ATRÁS'],
    [/\ball levels\b/g, 'todos los niveles'], [/\bFreezer\b/g, 'Congelador'], [/\bCooler\b/g, 'Refrigerador'],
  ];

  let lang = 'en';
  try { lang = localStorage.getItem('gunLang') === 'es' ? 'es' : 'en'; } catch { /* private window */ }

  function tr(text) {
    if (lang !== 'es' || text == null) return text;
    const s = String(text);
    const raw = s.trim();
    if (!raw) return s;
    const lead = s.slice(0, s.indexOf(raw));
    const tail = s.slice(s.indexOf(raw) + raw.length);
    const trimmed = raw.replace(/\s+/g, ' ');           // markup line breaks are not part of the words
    if (Object.prototype.hasOwnProperty.call(ES, trimmed)) return lead + ES[trimmed] + tail;
    for (const [re, fn] of PATTERNS) {
      const m = re.exec(trimmed);
      if (m) return lead + fn(m) + tail;
    }
    let out = trimmed;
    for (const [re, to] of PIECES) out = out.replace(re, to);
    return lead + out + tail;
  }

  /* ---------------------------------------------------- the whole screen
     Every text node and the few attributes a person reads. The English is kept
     beside each node, so switching back is exact and a node the app rewrites
     is picked up as new English. */
  const original = new WeakMap();      // node -> its English
  const shown = new WeakMap();         // node -> what we last put there
  const ATTRS = ['placeholder', 'title'];
  let busy = false;

  function doNode(n) {
    if (n.nodeType === 3) {
      const v = n.nodeValue;
      if (!v || !v.trim()) return;
      const p = n.parentNode;
      if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || (p.closest && p.closest('[data-no-i18n]')))) return;
      if (shown.get(n) !== v) original.set(n, v);      // the app wrote it: that is English
      const want = lang === 'es' ? tr(original.get(n)) : original.get(n);
      if (v !== want) n.nodeValue = want;
      shown.set(n, want);
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.closest && n.closest('[data-no-i18n]')) return;
    for (const a of ATTRS) {
      if (!n.hasAttribute(a)) continue;
      const key = 'en' + a[0].toUpperCase() + a.slice(1);
      const v = n.getAttribute(a);
      if (n.dataset[key + 'Shown'] !== v) n.dataset[key] = v;
      const want = lang === 'es' ? tr(n.dataset[key]) : n.dataset[key];
      if (v !== want) n.setAttribute(a, want);
      n.dataset[key + 'Shown'] = want;
    }
  }

  function walk(root) {
    if (!root) return;
    doNode(root);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) doNode(n);
  }

  const observer = new MutationObserver((records) => {
    if (busy) return;
    busy = true;
    try {
      for (const r of records) {
        if (r.type === 'characterData') doNode(r.target);
        else if (r.type === 'attributes') doNode(r.target);
        else for (const n of r.addedNodes) walk(n);
      }
    } finally { busy = false; }
  });

  function start() {
    walk(document.body);
    document.documentElement.lang = lang;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    renderButton();
  }

  function renderButton() {
    const b = document.getElementById('btnLang');
    if (!b) return;
    // the button offers the OTHER language, in that language
    b.textContent = lang === 'es' ? 'English' : 'Español';
    b.setAttribute('aria-label', lang === 'es' ? 'Switch to English' : 'Cambiar a español');
  }

  function set(next) {
    lang = next === 'es' ? 'es' : 'en';
    try { localStorage.setItem('gunLang', lang); } catch { /* private window */ }
    document.documentElement.lang = lang;
    busy = true;
    try { walk(document.body); } finally { busy = false; }
    renderButton();
    document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
  }

  window.i18n = { t: tr, set, get lang() { return lang; }, start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
