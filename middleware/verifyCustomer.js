
const verifyCustomer = (req, res, next) => {
  if (req.user.role !== "customer") {
    return res.status(403).send({
      message: "Forbidden: Customer access only",
    });
  }

  next();
};

export default verifyCustomer;
