
const verifyTechnician = (req, res, next) => {
  if (req.user.role !== "technician") {
    return res.status(403).send({
      message: "Forbidden: Technician access only",
    });
  }

  next();
};

export default verifyTechnician;
