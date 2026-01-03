require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

let db;
let asesorCollection;
let actividadCollection;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: false
}));
app.use(express.json());
app.use(express.static('.'));
app.use(express.static(path.join(__dirname)));


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

// CREAR NUEVO ASESOR
app.post('/api/asesores/crear', async (req, res) => {
  try {
    const { nombre, email, telefono, empresa, dias_pagados } = req.body;

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
    fecha_expiracion.setDate(fecha_expiracion.getDate() + parseInt(dias_pagados));

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
      accesos_total: 0,
      cotizaciones_generadas: 0,
      clientes_unicos: new Set(),
      ultimo_acceso: null,
      fecha_cancelacion: null,
      razon_cancelacion: null,
      renovaciones: []
    };

    const resultado = await asesorCollection.insertOne(nuevoAsesor);

    res.json({
      success: true,
      message: 'Asesor creado correctamente',
      asesor: {
        ...nuevoAsesor,
        _id: resultado.insertedId,
        url: `https://tuplanisapre.vercel.app/${url_slug}`,
        clientes_unicos: Array.from(nuevoAsesor.clientes_unicos)
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
    const { cliente_nombre, cliente_email, plan1, plan2, monto } = req.body;

    const registro_actividad = {
      url_slug: slug,
      tipo: 'cotizacion',
      fecha: new Date(),
      cliente_nombre,
      cliente_email,
      plan1,
      plan2,
      monto,
      ip: req.ip
    };

    await actividadCollection.insertOne(registro_actividad);

    // Actualizar contador de cotizaciones
    const asesor = await asesorCollection.findOne({ url_slug: slug });
    await asesorCollection.updateOne(
      { url_slug: slug },
      {
        $set: { cotizaciones_generadas: (asesor.cotizaciones_generadas || 0) + 1 },
        $addToSet: { clientes_unicos: cliente_email || req.ip }
      }
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

// ============================================
// RUTA DINÁMICA PARA ASESORES (IMPORTANTE)
// ============================================

// Servir index.html para rutas dinámicas de asesores
app.get('/:slug', (req, res) => {
  // No servir si es una extensión de archivo o rutas especiales
  if (req.params.slug && !req.params.slug.includes('.') && req.params.slug !== 'api') {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📊 Panel Admin Asesores: http://localhost:${PORT}/admin-asesores.html`);
  });
});






