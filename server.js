require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

// ================================
// CONFIG WHATSAPP CLOUD API
// ================================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

console.log('🧪 WHATSAPP ENV CHECK', {
  WHATSAPP_TOKEN: !!WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: !!WHATSAPP_PHONE_NUMBER_ID
});


let db;
let asesorCollection;
let actividadCollection;
let viproteinCollection;
let viproteinPedidosCollection;

async function validarAsesorActivo(slug) {
  const asesor = await asesorCollection.findOne({ url_slug: slug });

  if (!asesor) {
    return { ok: false, motivo: 'ELIMINADO' };
  }

  if (asesor.estado !== 'activo') {
    return { ok: false, motivo: 'REVOCADO' };
  }

  if (asesor.fecha_cancelacion) {
    return { ok: false, motivo: 'CANCELADO' };
  }

  const ahora = new Date();
  if (ahora > new Date(asesor.fecha_expiracion)) {
    return { ok: false, motivo: 'EXPIRADO' };
  }

  return { ok: true, asesor };
}



// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: false
}));
app.use(express.json());
app.use(express.static('.'));
app.use(express.static(path.join(__dirname)));



function normalizarTelefono(to) {
  return String(to || "").replace(/\D/g, "");
}

async function enviarWhatsAppTexto({ to, body }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    throw new Error("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID");
  }

  const toDigits = normalizarTelefono(to);
  if (!toDigits) {
    throw new Error("Teléfono destino inválido");
  }

  const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toDigits,
    type: "text",
    text: { body }
  };
  
// 🔎 SOLO PARA DIAGNOSTICAR
  console.log("➡️ Enviando a WhatsApp:", {
    url,
    toDigits,
    body: body.slice(0, 60) + "..."
  });
  
    const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    data = {};
  }

  // 🔎 LOG DE RESPUESTA
  console.log("⬅️ Respuesta WhatsApp:", {
    status: resp.status,
    data
  });

  if (!resp.ok) {
    console.error("WhatsApp API error:", data);
    throw new Error(data?.error?.message || "Error enviando WhatsApp");
  }

  return data;
}

// ============================================
// FUNCIÓN CALLMEBOT (NO INTERFIERE CON META)
// ============================================

async function enviarCallMeBotTexto({ to, body, apikey }) {
  const toDigits = normalizarTelefono(to);

  if (!toDigits || !apikey) {
    throw new Error("CallMeBot: faltan datos");
  }

  const url = `https://api.callmebot.com/whatsapp.php?phone=${toDigits}&text=${encodeURIComponent(body)}&apikey=${apikey}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error("Error enviando con CallMeBot");
  }

  return { success: true };
}

// ✅ Diagnóstico rápido: ver si están cargadas las variables de WhatsApp
app.get("/api/whatsapp-status", (req, res) => {
  res.json({
    ok: true,
    hasToken: !!process.env.WHATSAPP_TOKEN,
    hasPhoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
    node: process.version
  });
});
// ✅ PRUEBA ENVÍO WHATSAPP (ruta temporal)
app.get("/api/test-whatsapp", async (req, res) => {
  try {
    const to = req.query.to; // ej: 56990701837
    if (!to) {
      return res.status(400).json({ error: "Falta parámetro ?to=" });
    }

    const result = await enviarWhatsAppTexto({
      to,
      body: "✅ Prueba exitosa: WhatsApp Cloud API funcionando desde tu backend."
    });

    res.json({ success: true, result });
  } catch (err) {
    console.error("❌ Error enviando WhatsApp:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Servir admin.html
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Servir admin-asesores.html
app.get('/admin-asesores.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-asesores.html'));
});

// Conectar a MongoDB
async function connectDB() {
  try {
   global.client = new MongoClient(MONGODB_URI, {
  retryWrites: true,
w: 'majority'
});

    await client.connect();
    db = global.client.db('colmena');
    asesorCollection = db.collection('asesores');
    actividadCollection = db.collection('actividad');
    viproteinCollection = db.collection('viprotein_vendedores');
viproteinPedidosCollection = db.collection('viprotein_pedidos');
await viproteinCollection.createIndex({ url_slug: 1 });
await viproteinPedidosCollection.createIndex({ url_slug: 1 });
await viproteinPedidosCollection.createIndex({ fecha: -1 });
    
    // Crear índices
    await asesorCollection.createIndex({ url_slug: 1 });
    await asesorCollection.createIndex({ fecha_expiracion: 1 });
    await actividadCollection.createIndex({ url_slug: 1 });
    
    console.log('✅ Conectado a MongoDB');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
    process.exit(1);
  }
}

// ============================================
// RUTAS PARA GESTIÓN DE ASESORES
// ============================================
// ============================================
// ENVIAR LEAD POR WHATSAPP (Cloud API)
// ============================================
app.post('/api/enviar-lead', async (req, res) => {
  try {
    const { asesor, mensaje } = req.body;

    if (!asesor || !mensaje) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const validacion = await validarAsesorActivo(asesor);
    if (!validacion.ok) {
      return res.status(403).json({
        success: false,
        error: `ASESOR_${validacion.motivo}`
      });
    }

    const telAsesor = validacion.asesor.telefono;
    if (!telAsesor) {
      return res.status(400).json({
        success: false,
        error: 'ASESOR_SIN_TELEFONO'
      });
    }

    let result;

if (validacion.asesor.apikey && validacion.asesor.apikey.trim() !== "") {

  console.log("🟡 Usando CallMeBot (asesor con apikey)");

  result = await enviarCallMeBotTexto({
    to: telAsesor,
    body: mensaje,
    apikey: validacion.asesor.apikey
  });

} else {

  // 🔵 ESTA ES TU LÓGICA ACTUAL SIN MODIFICAR
  result = await enviarWhatsAppTexto({
    to: telAsesor,
    body: mensaje
  });

}

    res.json({ success: true, result });

  } catch (e) {
    console.error('❌ Error /api/enviar-lead:', e.message);
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

// CREAR NUEVO ASESOR
app.post('/api/asesores/crear', async (req, res) => {
  try {
    const { nombre, email, telefono, empresa, dias_pagados, apikey, con_landing, con_teleprompter, dias_teleprompter } = req.body;

    if (!nombre || !email || !telefono || !empresa || !dias_pagados) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    // Generar slug único
    let url_slug = nombre.toLowerCase().replace(/\s+/g, '-').normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let contador = 1;
    let slug_original = url_slug;
    
    while (await asesorCollection.findOne({ url_slug })) {
      url_slug = `${slug_original}-${contador}`;
      contador++;
    }

   const ahora = new Date();
const fecha_expiracion = new Date(ahora);
const diasParaExpiracion = con_landing !== false ? parseInt(dias_pagados) : parseInt(dias_teleprompter || 0);
fecha_expiracion.setDate(fecha_expiracion.getDate() + diasParaExpiracion);

    const nuevoAsesor = {
      nombre,
      email,
      telefono,
      empresa,
      url_slug,
      estado: 'activo',
      fecha_inicio: ahora,
      fecha_expiracion,
      dias_pagados: parseInt(dias_pagados),
      apikey: apikey || '',
      accesos_total: 0,
      cotizaciones_generadas: 0,
      clientes_unicos: [] ,
      ultimo_acceso: null,
      fecha_cancelacion: null,
      razon_cancelacion: null,
      renovaciones: [],
      con_landing: con_landing !== false,
      con_teleprompter: con_teleprompter === true
    };

    const resultado = await asesorCollection.insertOne(nuevoAsesor);
    // 🔵 CREAR USUARIO EN TELEPROMPTER (solo si fue solicitado)
if (con_teleprompter && dias_teleprompter && parseInt(dias_teleprompter) > 0) {
  try {
    await fetch("https://teleprompter-backend-production.up.railway.app/api/teleprompter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nombre: nuevoAsesor.nombre,
        slug: nuevoAsesor.url_slug,
        dias: parseInt(dias_teleprompter)
      })
    });
    console.log("✅ Usuario creado en teleprompter:", nuevoAsesor.url_slug);
  } catch (error) {
    console.error("❌ Error creando usuario en teleprompter:", error.message);
  }
}

    res.json({
      success: true,
      message: 'Asesor creado correctamente',
      asesor: {
        ...nuevoAsesor,
        _id: resultado.insertedId,
        url: `https://tuplanisapre.vercel.app/${url_slug}`,
        clientes_unicos: nuevoAsesor.clientes_unicos
      }
    });
  } catch (error) {
    console.error('Error creando asesor:', error);
    res.status(500).json({ error: 'Error creando asesor' });
  }
});

// OBTENER TODOS LOS ASESORES
app.get('/api/asesores', async (req, res) => {
  try {
    const asesores = await asesorCollection.find({}).toArray();
    
    const asesoresmapeados = asesores.map(a => ({
      ...a,
      clientes_unicos: Array.isArray(a.clientes_unicos) ? a.clientes_unicos : [],
      url: `https://tuplanisapre.vercel.app/${a.url_slug}`
    }));

    res.json(asesoresmapeados);
  } catch (error) {
    console.error('Error obteniendo asesores:', error);
    res.status(500).json({ error: 'Error obteniendo asesores' });
  }
});

// OBTENER ASESOR POR SLUG
app.get('/api/asesores/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const asesor = await asesorCollection.findOne({ url_slug: slug });

    if (!asesor) {
      return res.json({ valid: false, error: 'Asesor no encontrado' });
    }

    // Verificar si está expirado
    const ahora = new Date();
    if (ahora > asesor.fecha_expiracion) {
      return res.json({ valid: false, error: 'Acceso expirado' });
    }

    if (asesor.estado !== 'activo') {
      return res.json({ valid: false, error: `Acceso ${asesor.estado}` });
    }

    res.json({ 
      valid: true, 
      asesor: {
        nombre: asesor.nombre,
        email: asesor.email,
        telefono: asesor.telefono,
        empresa: asesor.empresa
      }
    });
  } catch (error) {
    console.error('Error obteniendo asesor:', error);
    res.status(500).json({ valid: false, error: 'Error validando asesor' });
  }
});

// REGISTRAR ACCESO (cuando cliente entra a la landing)
app.post('/api/asesores/:slug/registrar-acceso', async (req, res) => {
  try {
    const { slug } = req.params;
    const { cliente_nombre, cliente_email } = req.body;

    const asesor = await asesorCollection.findOne({ url_slug: slug });
    if (!asesor) {
      return res.status(404).json({ error: 'Asesor no encontrado' });
    }

    const registro_actividad = {
      url_slug: slug,
      tipo: 'acceso',
      fecha: new Date(),
      cliente_nombre: cliente_nombre || 'anónimo',
      cliente_email: cliente_email || null,
      ip: req.ip
    };

    await actividadCollection.insertOne(registro_actividad);

    // Actualizar estadísticas del asesor
    const actualizacion = {
      $set: {
        ultimo_acceso: new Date(),
        accesos_total: (asesor.accesos_total || 0) + 1
      },
      $addToSet: {
        clientes_unicos: cliente_email || req.ip
      }
    };

    await asesorCollection.updateOne({ url_slug: slug }, actualizacion);

    res.json({ success: true });
  } catch (error) {
    console.error('Error registrando acceso:', error);
    res.status(500).json({ error: 'Error registrando acceso' });
  }
});

// REGISTRAR COTIZACIÓN GENERADA
app.post('/api/asesores/:slug/registrar-cotizacion', async (req, res) => {
  try {
    const { slug } = req.params;
    const { cliente_nombre,
      cliente_email,
      cliente_telefono,
      rut,
      edad,
      region,
      renta,
      cargas,
      sieteUF,
      sieteCLP,
      plan1,
      plan2
      } = req.body;
    
    const rentaNum    = Number(renta || 0);
    const sieteUFNum  = Number(sieteUF || 0);
    const sieteCLPNum = Number(sieteCLP || 0);

        const validacion = await validarAsesorActivo(slug);

    if (!validacion.ok) {
      return res.status(403).json({
        success: false,
        error: `ASESOR_${validacion.motivo}`
      });
    }

    // ✅ Enviar WhatsApp al asesor dueño de ese slug
try {
  const asesor = validacion.asesor; // viene de validarAsesorActivo()

  const telAsesor = normalizarTelefono(asesor.telefono); // lo que guardas en el panel admin
  if (telAsesor) {
    const sieteUFNum  = Number(sieteUF || 0);
const sieteCLPNum = Number(sieteCLP || 0);
  const rentaNum = Number(renta || 0);
  
    const ahoraChile = new Date().toLocaleString("es-CL", {
  timeZone: "America/Santiago",
  // si quieres formato 24 horas, descomenta la siguiente línea:
  // hour12: false
});

    const msg = [
  "📌 Nueva cotización en tu landing",
          `Asesor: ${asesor.nombre} (${asesor.url_slug})`,
          `Cliente: ${cliente_nombre || "Sin nombre"}`,
          `Teléfono: ${cliente_telefono || "Sin teléfono"}`,
          `RUT: ${rut || "Sin RUT"}`,
          `Edad: ${edad ? `${edad} años` : "Sin edad"}`,
          `Email: ${cliente_email || "Sin email"}`,
          `Región: ${region || "-"}`,
          `Renta:  ${
        rentaNum ? `$${rentaNum.toLocaleString("es-CL")}` : "-"
      }`,
          `Cargas: ${
            Array.isArray(cargas) ? cargas.join(", ") : (cargas || "-")
          }`,
          `7% en UF: ${
        sieteUFNum ? sieteUFNum.toFixed(2) : "-"
      }`,
      `7% en CLP: ${
        sieteCLPNum ? `$${sieteCLPNum.toLocaleString("es-CL")}` : "-"
      }`,
          `Plan 1: ${plan1 || "-"}`,
          `Plan 2: ${plan2 || "-"}`,
          `Fecha: ${ahoraChile}`
].join("\n");

    if (asesor.apikey && asesor.apikey.trim() !== "") {

  console.log("🟡 registrar-cotizacion usando CallMeBot");

  await enviarCallMeBotTexto({
    to: telAsesor,
    body: msg,
    apikey: asesor.apikey
  });

} else {

  await enviarWhatsAppTexto({
    to: telAsesor,
    body: msg
  });

}
  } else {
    console.warn("⚠️ Asesor sin teléfono en DB:", asesor.url_slug);
  }
} catch (e) {
  console.error("❌ No se pudo enviar WhatsApp al asesor:", e.message);
  // OJO: NO cortamos la cotización. Solo registramos el error.
}


    const registro_actividad = {
      url_slug: slug,
      tipo: "cotizacion",
      fecha: new Date(),
      cliente_nombre,
      cliente_email,
      cliente_telefono,
      rut,
      edad,
      region,
      renta,
      cargas,
      sieteUF,
      sieteCLP,
      plan1,
      plan2,
      ip: req.ip
    };

    await actividadCollection.insertOne(registro_actividad);

    // Actualizar contador de cotizaciones
      const asesor = await asesorCollection.findOne({ url_slug: slug });

    const clienteId = cliente_email || req.ip;

    const update = {
      $set: {
        cotizaciones_generadas: (asesor?.cotizaciones_generadas || 0) + 1
      }
    };

    // Si clientes_unicos ya es array 👉 usamos $addToSet
    if (Array.isArray(asesor.clientes_unicos)) {
      update.$addToSet = { clientes_unicos: clienteId };
    } else {
      // Si es objeto / Set viejo 👉 lo pasamos a array
      update.$set.clientes_unicos = [clienteId];
    }

    await asesorCollection.updateOne(
      { url_slug: slug },
      update
    );


    res.json({ success: true });
  } catch (error) {
    console.error('Error registrando cotización:', error);
    res.status(500).json({ error: 'Error registrando cotización' });
  }
});

// OBTENER ACTIVIDAD DE UN ASESOR
app.get('/api/asesores/:slug/actividad', async (req, res) => {
  try {
    const { slug } = req.params;
    const actividad = await actividadCollection
      .find({ url_slug: slug })
      .sort({ fecha: -1 })
      .limit(100)
      .toArray();

    res.json(actividad);
  } catch (error) {
    console.error('Error obteniendo actividad:', error);
    res.status(500).json({ error: 'Error obteniendo actividad' });
  }
});

// RENOVAR ACCESO DE ASESOR
app.post('/api/asesores/:slug/renovar', async (req, res) => {
  try {
    const { slug } = req.params;
    const { dias } = req.body;

    if (!dias) {
      return res.status(400).json({ error: 'Especifica días' });
    }

    const asesor = await asesorCollection.findOne({ url_slug: slug });
    if (!asesor) {
      return res.status(404).json({ error: 'Asesor no encontrado' });
    }

    const nueva_fecha = new Date(asesor.fecha_expiracion);
    nueva_fecha.setDate(nueva_fecha.getDate() + parseInt(dias));

    const renovacion = {
      fecha: new Date(),
      dias: parseInt(dias),
      nueva_expiracion: nueva_fecha
    };

    await asesorCollection.updateOne(
      { url_slug: slug },
      {
        $set: {
          fecha_expiracion: nueva_fecha,
          estado: 'activo',
          fecha_cancelacion: null,
          razon_cancelacion: null
        },
        $push: {
          renovaciones: renovacion
        }
      }
    );

    res.json({ 
      success: true, 
      message: 'Asesor renovado',
      nueva_expiracion: nueva_fecha 
    });
  } catch (error) {
    console.error('Error renovando asesor:', error);
    res.status(500).json({ error: 'Error renovando asesor' });
  }
});

// REVOCAR ACCESO DE ASESOR
app.post('/api/asesores/:slug/revocar', async (req, res) => {
  try {
    const { slug } = req.params;
    const { razon } = req.body;

    const asesor = await asesorCollection.findOne({ url_slug: slug });
    if (!asesor) {
      return res.status(404).json({ error: 'Asesor no encontrado' });
    }

    await asesorCollection.updateOne(
      { url_slug: slug },
      {
        $set: {
          estado: 'revocado',
          fecha_cancelacion: new Date(),
          razon_cancelacion: razon || 'Revocado por administrador'
        }
      }
    );

    res.json({ success: true, message: 'Acceso revocado' });
  } catch (error) {
    console.error('Error revocando asesor:', error);
    res.status(500).json({ error: 'Error revocando asesor' });
  }
});

// SUSPENDER ASESOR
app.post('/api/asesores/:slug/suspender', async (req, res) => {
  try {
    const { slug } = req.params;

    await asesorCollection.updateOne(
      { url_slug: slug },
      { $set: { estado: 'suspendido' } }
    );

    res.json({ success: true, message: 'Asesor suspendido' });
  } catch (error) {
    console.error('Error suspendiendo asesor:', error);
    res.status(500).json({ error: 'Error suspendiendo asesor' });
  }
});

// ACTIVAR ASESOR
app.post('/api/asesores/:slug/activar', async (req, res) => {
  try {
    const { slug } = req.params;

    await asesorCollection.updateOne(
      { url_slug: slug },
      { $set: { estado: 'activo' } }
    );

    res.json({ success: true, message: 'Asesor activado' });
  } catch (error) {
    console.error('Error activando asesor:', error);
    res.status(500).json({ error: 'Error activando asesor' });
  }
});

// EDITAR ASESOR
app.put('/api/asesores/:slug/editar', async (req, res) => {
  try {
    const { slug } = req.params;
    const { nombre, email, telefono, empresa, apikey, con_teleprompter } = req.body;
    if (!nombre || !email || !telefono) {
      return res.status(400).json({ error: 'Faltan datos' });
    }
    const updateFields = { nombre, email, telefono };
    if (empresa) updateFields.empresa = empresa;
    if (apikey !== undefined) updateFields.apikey = apikey;
    if (con_teleprompter !== undefined) updateFields.con_teleprompter = con_teleprompter;
    const resultado = await asesorCollection.updateOne(
      { url_slug: slug },
      { $set: updateFields }
    );
    if (resultado.modifiedCount === 0) {
      return res.status(404).json({ error: 'Asesor no encontrado' });
    }
    res.json({ success: true, message: 'Asesor actualizado' });
  } catch (error) {
    console.error('Error editando asesor:', error);
    res.status(500).json({ error: 'Error editando asesor' });
  }
});

// ELIMINAR ASESOR
app.delete('/api/asesores/:slug/eliminar', async (req, res) => {
  try {
    const { slug } = req.params;

    const resultado = await asesorCollection.deleteOne({ url_slug: slug });

    if (resultado.deletedCount === 0) {
      return res.status(404).json({ error: 'Asesor no encontrado' });
    }

    res.json({ success: true, message: 'Asesor eliminado' });
  } catch (error) {
    console.error('Error eliminando asesor:', error);
    res.status(500).json({ error: 'Error eliminando asesor' });
  }
});

// ============================================
// RUTA DINÁMICA PARA ASESORES (VALIDADA)
// ============================================
// ============================================================
// RUTAS VIPROTEIN — Pega este bloque en tu server.js de Colmena
// ANTES de la línea: app.get('/:slug', (req, res) => {
// ============================================================

// Colección ViProtein (agregar junto a las otras colecciones al inicio)
// let viproteinCollection;
// Y dentro de connectDB() agregar:
// viproteinCollection = db.collection('viprotein_vendedores');
// await viproteinCollection.createIndex({ url_slug: 1 });

// ── CREAR VENDEDOR VIPROTEIN ─────────────────────────────────
app.post('/api/viprotein/crear', async (req, res) => {
  try {
    const { nombre, empresa, email, telefono, dias_pagados, plan } = req.body;

    if (!nombre || !dias_pagados) {
      return res.status(400).json({ error: 'Nombre y días son requeridos' });
    }

    // Generar slug único basado en el nombre
    let url_slug = nombre.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    let contador = 1;
    const slug_original = url_slug;
    while (await viproteinCollection.findOne({ url_slug })) {
      url_slug = `${slug_original}-${contador}`;
      contador++;
    }

    const ahora = new Date();
    const fecha_expiracion = new Date(ahora);
    fecha_expiracion.setDate(fecha_expiracion.getDate() + parseInt(dias_pagados));

    const nuevoVendedor = {
      nombre,
      empresa: empresa || '',
      email: email || '',
      telefono: telefono || '',
      url_slug,
      plan: plan || 'demo',
      estado: 'activo',
      fecha_inicio: ahora,
      fecha_expiracion,
      dias_pagados: parseInt(dias_pagados),
      accesos_total: 0,
      ultimo_acceso: null,
      renovaciones: []
    };

    const resultado = await viproteinCollection.insertOne(nuevoVendedor);

    res.json({
      success: true,
      vendedor: {
        ...nuevoVendedor,
        _id: resultado.insertedId,
        url: `https://viprotein-vendedor.vercel.app/${url_slug}`
      }
    });
  } catch (error) {
    console.error('Error creando vendedor ViProtein:', error);
    res.status(500).json({ error: 'Error creando vendedor' });
  }
});

// ── OBTENER TODOS LOS VENDEDORES ─────────────────────────────
app.get('/api/viprotein', async (req, res) => {
  try {
    const vendedores = await viproteinCollection.find({}).sort({ fecha_inicio: -1 }).toArray();
    res.json(vendedores);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo vendedores' });
  }
});

// ── VALIDAR VENDEDOR (la app lo llama al cargar) ─────────────
app.get('/api/viprotein/informes/generar/:tipo', async (req, res) => {
  const { tipo } = req.params;
  if (!['diario', 'semanal', 'mensual'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo debe ser diario, semanal o mensual' });
  }
  await generarYEnviarInforme(tipo);
  res.json({ success: true, message: `Informe ${tipo} generado y enviado` });
});
app.get('/api/viprotein/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const vendedor = await viproteinCollection.findOne({ url_slug: slug });

    if (!vendedor) {
      return res.json({ valid: false, error: 'Acceso no encontrado' });
    }

    const ahora = new Date();

    if (vendedor.estado !== 'activo') {
      return res.json({ valid: false, error: `Acceso ${vendedor.estado}` });
    }

    if (ahora > vendedor.fecha_expiracion) {
      return res.json({ valid: false, error: 'Acceso expirado' });
    }

    const dias_restantes = Math.ceil((vendedor.fecha_expiracion - ahora) / (1000 * 60 * 60 * 24));

    res.json({
      valid: true,
      dias_restantes,
      vendedor: {
        nombre: vendedor.nombre,
        empresa: vendedor.empresa,
        plan: vendedor.plan
      }
    });
  } catch (error) {
    res.status(500).json({ valid: false, error: 'Error validando acceso' });
  }
});

// ── REGISTRAR ACCESO ─────────────────────────────────────────
app.post('/api/viprotein/:slug/registrar-acceso', async (req, res) => {
  try {
    const { slug } = req.params;
    await viproteinCollection.updateOne(
      { url_slug: slug },
      { $set: { ultimo_acceso: new Date() }, $inc: { accesos_total: 1 } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error registrando acceso' });
  }
});

// ── RENOVAR ──────────────────────────────────────────────────
app.post('/api/viprotein/:slug/renovar', async (req, res) => {
  try {
    const { slug } = req.params;
    const { dias } = req.body;

    const vendedor = await viproteinCollection.findOne({ url_slug: slug });
    if (!vendedor) return res.status(404).json({ error: 'No encontrado' });

    // Si ya venció, renovar desde hoy; si está vigente, sumar desde la fecha de vencimiento
    const base = new Date(vendedor.fecha_expiracion) > new Date()
      ? new Date(vendedor.fecha_expiracion)
      : new Date();
    const nueva_fecha = new Date(base);
    nueva_fecha.setDate(nueva_fecha.getDate() + parseInt(dias));

    await viproteinCollection.updateOne(
      { url_slug: slug },
      {
        $set: { fecha_expiracion: nueva_fecha, estado: 'activo' },
        $push: { renovaciones: { fecha: new Date(), dias: parseInt(dias), nueva_expiracion: nueva_fecha } }
      }
    );

    res.json({ success: true, nueva_expiracion: nueva_fecha });
  } catch (error) {
    res.status(500).json({ error: 'Error renovando' });
  }
});

// ── EDITAR ───────────────────────────────────────────────────
app.put('/api/viprotein/:slug/editar', async (req, res) => {
  try {
    const { slug } = req.params;
    const { nombre, email, telefono, empresa } = req.body;
    await viproteinCollection.updateOne(
      { url_slug: slug },
      { $set: { nombre, email, telefono, empresa } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error editando' });
  }
});

// ── SUSPENDER ────────────────────────────────────────────────
app.post('/api/viprotein/:slug/suspender', async (req, res) => {
  try {
    await viproteinCollection.updateOne({ url_slug: req.params.slug }, { $set: { estado: 'suspendido' } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error suspendiendo' });
  }
});

// ── ACTIVAR ──────────────────────────────────────────────────
app.post('/api/viprotein/:slug/activar', async (req, res) => {
  try {
    await viproteinCollection.updateOne({ url_slug: req.params.slug }, { $set: { estado: 'activo' } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error activando' });
  }
});

// ── REVOCAR ──────────────────────────────────────────────────
app.post('/api/viprotein/:slug/revocar', async (req, res) => {
  try {
    const { razon } = req.body;
    await viproteinCollection.updateOne(
      { url_slug: req.params.slug },
      { $set: { estado: 'revocado', fecha_cancelacion: new Date(), razon_cancelacion: razon || 'Revocado' } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error revocando' });
  }
});

// ── FIN RUTAS VIPROTEIN ──────────────────────────────────────

app.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  // Ignorar archivos y rutas especiales
  if (!slug || slug.includes('.') || slug === 'api') {
    return;
  }

  try {
    const resultado = await validarAsesorActivo(slug);

    if (!resultado.ok) {
      return res.status(403).send(`
        <h2>⛔ Acceso ${resultado.motivo}</h2>
        <p>Este enlace ya no está disponible.</p>
      `);
    }

    res.sendFile(path.join(__dirname, 'index.html'));
  } catch (error) {
    console.error('Error validando asesor:', error);
    res.status(500).send('Error interno');
  }
});


// ============================================
// INICIAR SERVIDOR
// ============================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📊 Panel Admin Asesores disponible`);
});

// Conectar a Mongo SIN bloquear el arranque
connectDB().catch(err => {
  console.error("❌ MongoDB no disponible al iniciar:", err);
});




































