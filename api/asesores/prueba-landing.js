export default async function handler(req, res) {
  // ⭐ Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Manejar preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Obtener datos de asesores desde variable de entorno
    const aseoresDataString = process.env.ASESORES_DATA;
    
    if (!aseoresDataString) {
      return res.status(500).json({ 
        error: 'ASESORES_DATA no configurado' 
      });
    }

    // Parsear JSON
    const asesoresData = JSON.parse(aseoresDataString);
    
    // Buscar el asesor "prueba-landing" (ajusta el identificador según tu estructura)
    const asesor = asesoresData['prueba-landing'] || asesoresData['prueba_landing'];
    
    if (!asesor) {
      return res.status(404).json({ 
        error: 'Asesor no encontrado' 
      });
    }

    // Devolver datos del asesor
    return res.status(200).json({
      nombre: asesor.nombre,
      telefono: asesor.telefono,
      correo: asesor.correo,
      callmebot_apikey: asesor.callmebot_apikey
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: 'Error al procesar solicitud',
      detalle: error.message 
    });
  }
}
